import Foundation
@testable import RecorderApp
import Testing

/// M7 hardening surfaces, pure + view-model level (brief S7 items 2–3):
/// supervisor error ring (overflow-tested), delete.range params validation,
/// flows for status/settings/delete. GUI rendering is verified only by
/// code review here (no interactive window server in CI — see honest-limits).
@MainActor
struct HardeningSurfacesTests {
    // MARK: - SupervisorErrorRing

    @Test("ring keeps newest entries in insertion order")
    func ringOrdering() {
        var ring = SupervisorErrorRing(capacity: 3)
        ring.record(atMs: 1, scope: "s", code: "a", message: "one")
        ring.record(atMs: 2, scope: "s", code: "b", message: "two")
        ring.record(atMs: 3, scope: "s", code: "c", message: "three")
        #expect(ring.entries.map(\.code) == ["a", "b", "c"])
        #expect(ring.newestFirst.map(\.code) == ["c", "b", "a"])
    }

    @Test("ring overflow drops the OLDEST entry (capacity invariant)")
    func ringOverflowEvictsOldest() {
        var ring = SupervisorErrorRing(capacity: 20)
        for index in 0 ..< 30 {
            ring.record(atMs: Int64(index), scope: "supervisor", code: "exit_\(index)", message: "failure \(index)")
        }
        #expect(ring.entries.count == 20)
        // Entries 10..29 survive; 0..9 were evicted.
        #expect(ring.entries.first?.code == "exit_10")
        #expect(ring.entries.last?.code == "exit_29")
        #expect(ring.newestFirst.first?.code == "exit_29")
    }

    @Test("ring ids are monotonic so ForEach identity survives trims")
    func ringIdsMonotonic() {
        var ring = SupervisorErrorRing(capacity: 2)
        ring.record(atMs: 1, scope: "s", code: "a", message: "")
        ring.record(atMs: 2, scope: "s", code: "b", message: "")
        ring.record(atMs: 3, scope: "s", code: "c", message: "")
        let ids = ring.entries.map(\.id)
        #expect(ids == ids.sorted())
        #expect(Set(ids).count == ids.count)
    }

    @Test("AppState.recordSupervisorError feeds the ring with the injected clock")
    func appStateSupervisorFeed() {
        let state = AppState(daemon: FakeDaemonAPI())
        state.clock = FixedClock(ms: 1_787_443_200_000)
        state.recordSupervisorError(scope: "daemon-supervisor", code: "daemon_exit", message: "exited with code 46")
        state.recordSupervisorError(scope: "daemon-supervisor", code: "supervisor_degraded", message: "degraded")

        #expect(state.supervisorErrors.entries.count == 2)
        #expect(state.supervisorErrors.entries[0].atMs == 1_787_443_200_000)
        #expect(state.supervisorErrors.entries[0].code == "daemon_exit")
        #expect(state.supervisorErrors.entries[1].code == "supervisor_degraded")
        #expect(!state.supervisorErrors.isEmpty)
    }

    // MARK: - DeleteRangeParams validation (exactly-one-of rule)

    @Test("preset-only and range-only params validate; mixed and empty reject")
    func deleteParamsValidation() throws {
        try DeleteRangeParams(preset: .all).validate()
        try DeleteRangeParams(from: 1000, to: 2000).validate()
        try DeleteRangeParams(from: 1000, to: nil, preset: nil).validate()

        #expect(throws: DeleteRangeValidationError.mixedPresetAndRange) {
            try DeleteRangeParams(from: 1000, to: 2000, preset: .today).validate()
        }
        #expect(throws: DeleteRangeValidationError.emptySelection) {
            try DeleteRangeParams().validate()
        }
    }

    @Test("nil param fields are OMITTED from the wire JSON (additionalProperties:false)")
    func deleteParamsEncodingOmitsNils() throws {
        let encoder = JSONEncoder()
        let presetOnly = try String(data: encoder.encode(DeleteRangeParams(preset: .lastHour)), encoding: .utf8)
        #expect(presetOnly == #"{"preset":"last_hour"}"#)

        // Key ORDER in JSONEncoder output is not guaranteed; assert the
        // key SET instead (from+to present, preset absent).
        let rangeOnly = try JSONSerialization.jsonObject(
            with: encoder.encode(DeleteRangeParams(from: 100, to: 200))
        ) as? [String: Any]
        #expect(rangeOnly?.keys.sorted() == ["from", "to"])
        #expect(rangeOnly?["from"] as? Int == 100 && rangeOnly?["to"] as? Int == 200)

        // All four presets round-trip through their pinned wire spellings.
        let wireValues = try DeleteRangePreset.allCases.map { preset -> String in
            try #require(try String(
                data: encoder.encode(DeleteRangeParams(preset: preset)),
                encoding: .utf8
            ))
        }
        #expect(wireValues == [
            #"{"preset":"last_10_minutes"}"#,
            #"{"preset":"last_hour"}"#,
            #"{"preset":"today"}"#,
            #"{"preset":"all"}"#,
        ])

        // memories.list mirrors the same convention: status nil → omitted,
        // limit non-nil → encoded (TS clamps it to 1...200).
        let noFilter = try JSONSerialization.jsonObject(
            with: encoder.encode(MemoriesListParams(status: nil, limit: nil))
        ) as? [String: Any]
        #expect(noFilter?.isEmpty == true)
        let pageSize = try JSONSerialization.jsonObject(
            with: encoder.encode(MemoriesListParams(status: nil, limit: 50))
        ) as? [String: Any]
        #expect(pageSize?.keys.sorted() == ["limit"])
        #expect(pageSize?["limit"] as? Int == 50)
    }

    @Test("delete.range result decodes the per-table counts block")
    func deleteResultDecoding() throws {
        let json = Data(#"{"deleted":{"rawEvents":142,"steps":37,"episodes":3,"memories":1,"workflows":0}}"#.utf8)
        let result = try JSONDecoder().decode(DeleteRangeResult.self, from: json)
        #expect(result.deleted.rawEvents == 142)
        #expect(result.deleted.steps == 37)
        #expect(result.deleted.episodes == 3)
        #expect(result.deleted.memories == 1)
        #expect(result.deleted.workflows == 0)
    }

    // MARK: - CapturePolicyReducer (settings policy editor transitions)

    @Test("setOverride adds, updates, and clears (inherit) one app row")
    func policySetOverride() {
        let base = CapturePolicy.standard

        let added = CapturePolicyReducer.setOverride(base, bundleId: "com.apple.Safari", mode: .content)
        #expect(added.perApp["com.apple.Safari"] == .content)
        #expect(base.perApp.isEmpty) // value semantics: original untouched

        let updated = CapturePolicyReducer.setOverride(added, bundleId: "com.apple.Safari", mode: .off)
        #expect(updated.perApp["com.apple.Safari"] == .off)

        let cleared = CapturePolicyReducer.setOverride(updated, bundleId: "com.apple.Safari", mode: nil)
        #expect(cleared.perApp["com.apple.Safari"] == nil)
        #expect(cleared.defaultMode == base.defaultMode)
    }

    @Test("setDefaultMode changes only the fallback; removeApp equals clearing the override")
    func policyDefaultAndRemove() {
        let base = CapturePolicyReducer.setOverride(
            CapturePolicy(defaultMode: .metadata, perApp: ["com.google.Chrome": .off]),
            bundleId: "rebel.slack",
            mode: .content
        )
        let flipped = CapturePolicyReducer.setDefaultMode(base, mode: .content)
        #expect(flipped.defaultMode == .content)
        #expect(flipped.perApp == base.perApp)

        let removed = CapturePolicyReducer.removeApp(flipped, bundleId: "rebel.slack")
        #expect(removed.perApp["rebel.slack"] == nil)
        #expect(removed.perApp["com.google.Chrome"] == .off)
        #expect(removed == CapturePolicyReducer.setOverride(flipped, bundleId: "rebel.slack", mode: nil))
    }

    // MARK: - DeleteHistoryReducer (day-range selection)

    @Test("utcDayBounds covers exactly the UTC calendar day containing nowMs")
    func dayBounds() throws {
        // 2026-08-23T12:34:56Z sits inside 2026-08-23T00:00:00Z..24h.
        let nowMs: Int64 = 1_787_470_096_000
        let bounds = DeleteHistoryReducer.utcDayBounds(containing: nowMs)
        #expect(bounds.from < nowMs && nowMs < bounds.to)
        #expect(bounds.to - bounds.from == 86_400_000)
        #expect(bounds.from % 86_400_000 == 0) // aligned to UTC midnight
        // Under a UTC calendar the picked-day range coincides with the UTC day;
        // under .current it is the LOCAL calendar day (SD-1) and may differ.
        var utcCalendar = Calendar(identifier: .gregorian)
        utcCalendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        #expect(
            DeleteHistoryReducer.dayRangeParams(
                for: Date(timeIntervalSince1970: 1_787_470_096), calendar: utcCalendar
            ).from == bounds.from
        )
    }

    // MARK: - AppState delete flow (injected executor)

    private static func deletedCounts(
        rawEvents: Int = 5, steps: Int = 2, episodes: Int = 1, memories: Int = 0, workflows: Int = 0
    ) -> DeleteRangeDeletedCounts {
        DeleteRangeDeletedCounts(
            rawEvents: rawEvents, steps: steps, episodes: episodes,
            memories: memories, workflows: workflows
        )
    }

    @Test("runDeleteHistory reports completion counts on success")
    func deleteFlowSuccess() async {
        let api = FakeDaemonAPI()
        api.onDeleteHistory = { params in
            #expect(params.preset == .last10Minutes)
            return Self.deletedCounts(rawEvents: 42)
        }
        let state = AppState(daemon: api)
        await state.runDeleteHistory(params: DeleteRangeParams(preset: .last10Minutes))
        #expect(!state.deleteInFlight)
        #expect(state.deleteError == nil)
        #expect(state.lastDeleteCounts?.rawEvents == 42)
    }

    @Test("runDeleteHistory surfaces the failure message and stays retryable")
    func deleteFlowFailure() async {
        let api = FakeDaemonAPI()
        api.onDeleteHistory = { _ in throw DaemonClientError.notConnected }
        let state = AppState(daemon: api)
        await state.runDeleteHistory(params: DeleteRangeParams(preset: .today))
        #expect(!state.deleteInFlight)
        #expect(state.lastDeleteCounts == nil)
        #expect(state.deleteError != nil)

        // A failed attempt accepts a fresh run that succeeds.
        api.onDeleteHistory = { _ in Self.deletedCounts() }
        await state.runDeleteHistory(params: DeleteRangeParams(preset: .today))
        #expect(state.deleteError == nil)
        #expect(state.lastDeleteCounts != nil)
    }

    @Test("delete without a live connection fails fast with the offline banner text")
    func deleteFlowOffline() async {
        let state = AppState(daemon: FakeDaemonAPI())
        await state.runDeleteHistory(params: DeleteRangeParams(preset: .all))
        #expect(state.deleteError == "Daemon connection unavailable")
    }

    // MARK: - Diagnostics / settings loads (injected loaders)

    private static func statusResult() -> StatusResult {
        StatusResult(
            daemon: .init(version: "0.1.0", schemaVersion: 4, uptimeMs: 72000),
            recording: .init(paused: true, reason: "disk_pressure"),
            accessibilityRequired: false,
            queue: .init(pending: 3, retrying: 1, dead: 2),
            db: .init(
                rawEvents: 1200, segments: 40, steps: 300, episodes: 12,
                memories: 8, workflows: 2, pageCountBytes: 1_048_576
            ),
            diskFreeBytes: 2_147_483_648
        )
    }

    @Test("refreshDiagnostics stores the snapshot and best-effort settings; failure is typed")
    func diagnosticsLoadCycle() async {
        let api = FakeDaemonAPI()
        api.onFetchStatus = { Self.statusResult() }
        api.onFetchDiagnostics = {
            DiagnosticsGetResult(integrityOk: true, lastErrors: [])
        }
        api.onFetchSettings = {
            SettingsGetResult(settings: DaemonSettingsDto(
                chatModel: "openai/gpt-5.6-luna", backgroundModel: "haiku",
                rawRetentionHours: 48, semanticRetentionDays: 30
            ))
        }
        let state = AppState(daemon: api)
        await state.refreshDiagnostics()
        await state.refreshDaemonSettings()
        #expect(state.diagnosticsPhase == .loaded)
        #expect(state.lastStatus?.db.episodes == 12)
        #expect(state.lastStatus?.queue.dead == 2)
        #expect(state.daemonDiagnostics?.integrityOk == true)
        #expect(state.daemonSettingsDisplay?.chatModel == "openai/gpt-5.6-luna")

        // Loader failure surfaces as a failed phase without wiping the last
        // good snapshot.
        api.onFetchStatus = { throw DaemonClientError.notConnected }
        await state.refreshDiagnostics()
        guard case .failed = state.diagnosticsPhase else {
            Issue.record("expected .failed phase after loader error")
            return
        }
        #expect(state.lastStatus?.db.episodes == 12)
    }

    @Test("diagnostics without a connection fail fast before any load")
    func diagnosticsOffline() async {
        let state = AppState(daemon: FakeDaemonAPI())
        await state.refreshDiagnostics()
        #expect(state.diagnosticsPhase == .failed("Daemon connection unavailable"))
        #expect(state.lastStatus == nil)

        await state.refreshDaemonSettings()
        #expect(state.settingsPhase == .failed("Daemon connection unavailable"))
    }

    // MARK: - Read-only settings display decoding

    @Test("DaemonSettingsDto decodes the daemon-managed display block")
    func settingsDtoDecoding() throws {
        let json = Data(#"{"settings":{"chatModel":"m1","backgroundModel":"m2","rawRetentionHours":48,"semanticRetentionDays":30}}"#.utf8)
        let result = try JSONDecoder().decode(SettingsGetResult.self, from: json)
        #expect(result.settings.chatModel == "m1")
        #expect(result.settings.backgroundModel == "m2")
        #expect(result.settings.rawRetentionHours == 48)
        #expect(result.settings.semanticRetentionDays == 30)
    }

    // MARK: - Migration-004 step mirror

    @Test("targetRole is decode-safe when absent or null (pre-004 historical steps)")
    func targetRoleDecodeSafety() throws {
        let absent = try JSONDecoder().decode(SemanticStepDto.self, from: Data(
            #"{"id":"s1","segmentId":"g1","ordinal":1,"startedAtMs":1,"endedAtMs":2,"action":"typing","appBundleId":"app","appName":"App","target":null,"text":null}"#.utf8
        ))
        #expect(absent.targetRole == nil)

        let nullRole = try JSONDecoder().decode(SemanticStepDto.self, from: Data(
            #"{"id":"s2","segmentId":"g1","ordinal":2,"startedAtMs":2,"endedAtMs":3,"action":"typing","appBundleId":"app","appName":null,"target":null,"text":"hi","targetRole":null}"#.utf8
        ))
        #expect(nullRole.targetRole == nil)

        let withRole = try JSONDecoder().decode(SemanticStepDto.self, from: Data(
            #"{"id":"s3","segmentId":"g1","ordinal":3,"startedAtMs":3,"endedAtMs":4,"action":"typing","appBundleId":"app","appName":null,"target":null,"text":null,"targetRole":"editor"}"#.utf8
        ))
        #expect(withRole.targetRole == "editor")
    }
}

/// Injectable clock stub matching contracts §Testing conventions.
private final class FixedClock: AppClock {
    let ms: Int64
    init(ms: Int64) {
        self.ms = ms
    }

    var nowMs: Int64 {
        ms
    }
}
