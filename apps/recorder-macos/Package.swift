// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "RecorderApp",
    platforms: [
        .macOS(.v14),
    ],
    targets: [
        .executableTarget(
            name: "RecorderApp",
            path: "Sources/RecorderApp"
        ),
        .testTarget(
            name: "RecorderAppTests",
            dependencies: ["RecorderApp"],
            path: "Tests/RecorderAppTests"
        ),
    ]
)
