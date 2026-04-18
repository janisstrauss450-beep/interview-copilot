// audiotap — captures macOS system audio via ScreenCaptureKit.
// Writes 24 kHz mono 16-bit PCM to stdout. Logs to stderr.
// Spawned by Electron's main process on macOS 13+.
//
// No virtual audio driver needed. Apple's ScreenCaptureKit taps system audio
// directly. User grants Screen Recording permission once; the app's own audio
// is excluded so we don't feed our own TTS/output back into the tap.

import Foundation
import ScreenCaptureKit
import AVFoundation

// MARK: - Logging

func logE(_ message: String) {
    if let data = "audiotap: \(message)\n".data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

// MARK: - Output writer (stdout, thread-safe enough for append-only writes)

let stdout = FileHandle.standardOutput
let outputLock = NSLock()

func writePCM(_ data: Data) {
    outputLock.lock()
    defer { outputLock.unlock() }
    do {
        try stdout.write(contentsOf: data)
    } catch {
        // Parent process has closed the pipe; exit cleanly.
        logE("stdout write failed: \(error.localizedDescription). exiting.")
        exit(0)
    }
}

// MARK: - Audio tap

@available(macOS 13.0, *)
final class AudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let targetSampleRate: Double = 24_000
    private let targetChannels: UInt32 = 1

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: false
        )
        guard let display = content.displays.first else {
            throw NSError(
                domain: "audiotap",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No displays reported by SCShareableContent"]
            )
        }

        // We don't actually want video; but SCStreamConfiguration always captures
        // video frames. We configure them tiny and ignore them via not adding a
        // video output. (macOS 14+ supports audio-only, but 13 needs this.)
        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(
            self,
            type: .audio,
            sampleHandlerQueue: DispatchQueue(label: "audiotap.audio", qos: .userInteractive)
        )
        try await stream.startCapture()
        self.stream = stream
        logE("started (48kHz stereo in → \(Int(targetSampleRate))Hz mono int16 out)")
        // Signal readiness by writing a single byte? No — stdout is audio data. Rely on stderr.
        logE("ready")
    }

    func stop() async {
        guard let stream = self.stream else { return }
        try? await stream.stopCapture()
        self.stream = nil
    }

    // MARK: SCStreamOutput

    nonisolated func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio else { return }

        guard let formatDescRef = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescRef)
        else { return }

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        if frameCount <= 0 { return }

        guard let srcFormat = AVAudioFormat(streamDescription: asbdPtr) else { return }
        guard let dstFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: targetChannels,
            interleaved: true
        ) else { return }

        // Copy sample buffer into a PCMBuffer.
        guard let srcBuffer = AVAudioPCMBuffer(
            pcmFormat: srcFormat,
            frameCapacity: AVAudioFrameCount(frameCount)
        ) else { return }
        srcBuffer.frameLength = AVAudioFrameCount(frameCount)

        let copyStatus = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frameCount),
            into: srcBuffer.mutableAudioBufferList
        )
        if copyStatus != noErr {
            logE("CMSampleBufferCopyPCMDataIntoAudioBufferList failed: \(copyStatus)")
            return
        }

        // Convert to 24 kHz mono int16.
        guard let converter = AVAudioConverter(from: srcFormat, to: dstFormat) else {
            logE("AVAudioConverter init failed (src: \(srcFormat), dst: \(dstFormat))")
            return
        }

        let ratio = dstFormat.sampleRate / srcFormat.sampleRate
        let outCapacity = AVAudioFrameCount(
            Double(srcBuffer.frameLength) * ratio + 64
        )
        guard let dstBuffer = AVAudioPCMBuffer(
            pcmFormat: dstFormat,
            frameCapacity: outCapacity
        ) else { return }

        var convertError: NSError?
        var provided = false
        let status = converter.convert(to: dstBuffer, error: &convertError) { _, outStatus in
            if provided {
                outStatus.pointee = .endOfStream
                return nil
            }
            provided = true
            outStatus.pointee = .haveData
            return srcBuffer
        }

        if let err = convertError {
            logE("convert error: \(err.localizedDescription)")
            return
        }
        if status == .error { return }

        // Emit.
        guard let int16Ptr = dstBuffer.int16ChannelData?.pointee else { return }
        let outFrames = Int(dstBuffer.frameLength)
        if outFrames <= 0 { return }
        let byteCount = outFrames * MemoryLayout<Int16>.size * Int(targetChannels)
        let pcmData = Data(bytes: int16Ptr, count: byteCount)
        writePCM(pcmData)
    }

    // MARK: SCStreamDelegate

    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        logE("stream stopped with error: \(error.localizedDescription)")
        exit(3)
    }
}

// MARK: - Entry

if #unavailable(macOS 13.0) {
    logE("requires macOS 13 or later")
    exit(4)
}

let tap = AudioTap()

signal(SIGTERM) { _ in
    logE("SIGTERM — exiting")
    exit(0)
}
signal(SIGINT) { _ in
    logE("SIGINT — exiting")
    exit(0)
}
// Exit cleanly when parent closes stdout (pipe broken).
signal(SIGPIPE) { _ in
    logE("SIGPIPE — exiting")
    exit(0)
}

Task {
    do {
        try await tap.start()
    } catch {
        logE("failed to start: \(error.localizedDescription)")
        exit(2)
    }
}

RunLoop.main.run()
