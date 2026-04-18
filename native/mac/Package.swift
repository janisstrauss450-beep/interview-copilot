// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "audiotap",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "audiotap", targets: ["audiotap"]),
    ],
    targets: [
        .executableTarget(
            name: "audiotap",
            path: "Sources/audiotap"
        ),
    ]
)
