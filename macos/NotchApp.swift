import Cocoa
import WebKit
import AVFoundation
import Carbon

// Global reference for Carbon HotKey C callback
private weak var sharedAppDelegate: AppDelegate?

private func carbonHotKeyHandler(
    nextHandler: EventHandlerCallRef?,
    theEvent: EventRef?,
    userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let theEvent = theEvent else { return OSStatus(eventNotHandledErr) }
    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(
        theEvent,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )
    if status == noErr {
        DispatchQueue.main.async {
            switch hotKeyID.id {
            case 1:
                sharedAppDelegate?.toggleNotchExpand()
            case 2:
                sharedAppDelegate?.toggleVoiceCall()
            case 3:
                sharedAppDelegate?.cyclePrevBot()
            case 4:
                sharedAppDelegate?.cycleNextBot()
            case 5:
                sharedAppDelegate?.handleEscapeKey()
            case 6:
                sharedAppDelegate?.toggleMute()
            case 7:
                sharedAppDelegate?.toggleSettings()
            default:
                break
            }
        }
    }
    return noErr
}

// MARK: - Non-Activating Borderless Notch Panel
final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// MARK: - Transparent WebView with First-Click Acceptance
final class NotchWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }
}

// MARK: - Private stdio Bridge to the Bundled Node Process
// Security: the Node bridge has no network listener. It is reachable only through these pipes,
// and the web UI reaches it only through the app-private gbnotch:// URL scheme below.
final class NodeBridge {
    private let process = Process()
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let queue = DispatchQueue(label: "gbnotch.bridge")
    private var buffer = Data()
    private var nextId = 0
    private var pending: [Int: (Int, [String: String], Data) -> Void] = [:]

    func start() {
        guard let resources = Bundle.main.resourceURL else { return }
        // Security: always run the pinned, checksum-verified Node bundled inside the app, never one from PATH.
        process.executableURL = resources.appendingPathComponent("node/bin/node")
        process.arguments = [resources.appendingPathComponent("app/server.mjs").path]
        process.currentDirectoryURL = resources.appendingPathComponent("app")
        process.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin"]
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = Self.logFileHandle()
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            self?.queue.async { self?.consume(chunk) }
        }
        do {
            try process.run()
        } catch {
            NSLog("[GrokBotNotch] Failed to start bundled Node bridge: \(error)")
        }
        // Runs first on the serial queue, so every API request waits until the Keychain answer arrives.
        queue.async {
            guard let password = Self.readGrokBotSafeStoragePassword() else { return }
            self.writeLine(["type": "safeStorage", "password": password])
        }
    }

    private static func readGrokBotSafeStoragePassword() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Grok Bot Safe Storage",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func writeLine(_ msg: [String: Any]) {
        guard var line = try? JSONSerialization.data(withJSONObject: msg) else { return }
        line.append(0x0A)
        stdinPipe.fileHandleForWriting.write(line)
    }

    func stop() {
        try? stdinPipe.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
    }

    func send(method: String, url: String, body: Data?, completion: @escaping (Int, [String: String], Data) -> Void) {
        queue.async {
            self.nextId += 1
            let id = self.nextId
            self.pending[id] = completion
            self.writeLine(["id": id, "method": method, "url": url, "body": body.flatMap { String(data: $0, encoding: .utf8) } ?? ""])
        }
    }

    private func consume(_ chunk: Data) {
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let id = obj["id"] as? Int,
                  let completion = pending.removeValue(forKey: id) else { continue }
            let status = obj["status"] as? Int ?? 500
            let headers = obj["headers"] as? [String: String] ?? [:]
            let body = (obj["body"] as? String).flatMap { Data(base64Encoded: $0) } ?? Data()
            completion(status, headers, body)
        }
    }

    private static func logFileHandle() -> FileHandle? {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/GrokBotNotch")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = dir.appendingPathComponent("bridge.log")
        FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let handle = try? FileHandle(forWritingTo: file)
        handle?.truncateFile(atOffset: 0)
        return handle
    }
}

// MARK: - App-Private gbnotch:// Scheme (serves UI + API through the stdio bridge)
final class NotchSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "gbnotch"
    private let bridge: NodeBridge
    private var active = Set<ObjectIdentifier>()

    init(bridge: NodeBridge) { self.bridge = bridge }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app" else {
            task.didFailWithError(URLError(.unsupportedURL))
            return
        }
        let key = ObjectIdentifier(task)
        active.insert(key)
        var path = url.path.isEmpty ? "/" : url.path
        if let q = url.query { path += "?\(q)" }
        bridge.send(method: task.request.httpMethod ?? "GET", url: path, body: task.request.httpBody) { [weak self] status, headers, body in
            DispatchQueue.main.async {
                guard let self = self, self.active.remove(key) != nil else { return }
                var h = headers
                // Security: lock the page down to its own scheme plus the xAI realtime socket.
                h["Content-Security-Policy"] = "default-src 'self'; connect-src 'self' wss://api.x.ai; img-src 'self' data:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
                guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: h) else { return }
                task.didReceive(response)
                task.didReceive(body)
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        active.remove(ObjectIdentifier(task))
    }
}

// MARK: - Native 24kHz AVAudioEngine Voice Pipeline
final class NativeVoiceAudioController {
    private var engine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var targetFormat: AVAudioFormat?
    private var playerFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var isRunning = false
    private var isMuted = false
    private var pendingBuffers = 0
    weak var webView: WKWebView?

    func setMuted(_ muted: Bool) {
        self.isMuted = muted
    }

    func start() {
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            guard granted else {
                DispatchQueue.main.async {
                    self?.webView?.evaluateJavaScript("window.__onNativeMicDenied && window.__onNativeMicDenied()", completionHandler: nil)
                }
                return
            }
            DispatchQueue.main.async {
                self?.setupAndStartEngine()
            }
        }
    }

    private func setupAndStartEngine() {
        stop()

        let eng = AVAudioEngine()
        let player = AVAudioPlayerNode()
        eng.attach(player)

        guard let playFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false),
              let micTargetFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true) else {
            return
        }
        self.playerFormat = playFmt
        self.targetFormat = micTargetFmt

        eng.connect(player, to: eng.mainMixerNode, format: playFmt)

        let inputNode = eng.inputNode
        // Apple voice processing = echo cancellation, so the agent doesn't hear itself through the speakers.
        do {
            try inputNode.setVoiceProcessingEnabled(true)
        } catch {
            NSLog("[GrokBotNotch] Voice processing unavailable: \(error)")
        }
        let hwFormat = inputNode.outputFormat(forBus: 0)
        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else { return }

        // Voice processing can deliver several channels; only channel 0 carries the cleaned mic signal.
        guard let monoFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: hwFormat.sampleRate, channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: monoFmt, to: micTargetFmt) else { return }
        self.converter = conv
        NSLog("[GrokBotNotch] Mic format: \(hwFormat)")

        inputNode.installTap(onBus: 0, bufferSize: 2048, format: hwFormat) { [weak self] buffer, _ in
            guard let self = self, self.isRunning, !self.isMuted,
                  let src = buffer.floatChannelData?[0],
                  let mono = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: buffer.frameLength),
                  let dst = mono.floatChannelData?[0] else { return }
            mono.frameLength = buffer.frameLength
            dst.update(from: src, count: Int(buffer.frameLength))
            self.processMicBuffer(mono, converter: conv, targetFormat: micTargetFmt)
        }

        do {
            try eng.start()
            player.play()
            self.engine = eng
            self.playerNode = player
            self.isRunning = true
        } catch {
            NSLog("[GrokBotNotch] AVAudioEngine start failed: \(error)")
        }
    }

    private func processMicBuffer(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter, targetFormat: AVAudioFormat) {
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var consumed = false
        var error: NSError?
        converter.convert(to: outBuffer, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }

        guard error == nil, outBuffer.frameLength > 0, let int16Ptr = outBuffer.int16ChannelData?[0] else { return }
        let frameCount = Int(outBuffer.frameLength)
        var sumSquares: Float = 0
        for i in 0..<frameCount {
            let norm = Float(int16Ptr[i]) / 32768.0
            sumSquares += norm * norm
        }
        let rms = sqrt(sumSquares / Float(max(1, frameCount)))
        let byteCount = frameCount * 2
        let data = Data(bytes: int16Ptr, count: byteCount)
        let b64 = data.base64EncodedString()

        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.isRunning else { return }
            let reportedRms = (self.pendingBuffers == 0) ? rms : 0
            self.webView?.evaluateJavaScript(
                "window.__onNativeMicFrame && window.__onNativeMicFrame('\(b64)', \(reportedRms))",
                completionHandler: nil
            )
        }
    }

    func playBase64Pcm16(_ base64: String) {
        guard isRunning, let player = playerNode, let playFmt = playerFormat else { return }
        guard let data = Data(base64Encoded: base64), data.count >= 2 else { return }
        let sampleCount = data.count / 2
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: playFmt, frameCapacity: AVAudioFrameCount(sampleCount)),
              let floatChannel = pcmBuffer.floatChannelData?[0] else { return }

        pcmBuffer.frameLength = AVAudioFrameCount(sampleCount)
        var sumSquares: Float = 0

        data.withUnsafeBytes { rawBuf in
            guard let int16Base = rawBuf.bindMemory(to: Int16.self).baseAddress else { return }
            for i in 0..<sampleCount {
                let sample = Float(int16Base[i]) / 32768.0
                floatChannel[i] = sample
                sumSquares += sample * sample
            }
        }

        let rms = sqrt(sumSquares / Float(max(1, sampleCount)))
        pendingBuffers += 1
        if !player.isPlaying {
            player.play()
        }

        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(
                "window.__onNativeSpeakerEnergy && window.__onNativeSpeakerEnergy(\(rms))",
                completionHandler: nil
            )
        }

        player.scheduleBuffer(pcmBuffer) { [weak self] in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.pendingBuffers = max(0, self.pendingBuffers - 1)
                if self.pendingBuffers == 0 {
                    self.webView?.evaluateJavaScript(
                        "window.__onNativeSpeakerEnergy && window.__onNativeSpeakerEnergy(0); window.__onNativeSpeechEnded && window.__onNativeSpeechEnded();",
                        completionHandler: nil
                    )
                }
            }
        }
    }

    func stopPlayback() {
        guard let player = playerNode else { return }
        player.stop()
        player.play()
        pendingBuffers = 0
        webView?.evaluateJavaScript("window.__onNativeSpeakerEnergy && window.__onNativeSpeakerEnergy(0)", completionHandler: nil)
    }

    func stop() {
        isRunning = false
        pendingBuffers = 0
        if let eng = engine {
            eng.inputNode.removeTap(onBus: 0)
            playerNode?.stop()
            eng.stop()
        }
        engine = nil
        playerNode = nil
        converter = nil
    }
}

// MARK: - Main Application Delegate
// MARK: - One Notch Surface per Screen (panel + web view + its own hover/hit state)
final class NotchSurface {
    let screenID: CGDirectDisplayID
    let panel: NotchPanel
    let webView: NotchWebView
    var hitRect = NSRect(x: 94, y: 0, width: 212, height: 56)
    var isOpen = false
    var isTyping = false
    var callPhase = "idle"
    var openedByHover = false
    var cursorVisitedOpenPouch = false
    var hoverWork: DispatchWorkItem?

    init(screenID: CGDirectDisplayID, panel: NotchPanel, webView: NotchWebView) {
        self.screenID = screenID
        self.panel = panel
        self.webView = webView
    }

    func send(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__notchCommand && window.__notchCommand(\(json))", completionHandler: nil)
    }

    func localPoint(_ screenPoint: NSPoint) -> NSPoint {
        NSPoint(x: screenPoint.x - panel.frame.minX, y: panel.frame.maxY - screenPoint.y)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
    private var surfaces: [NotchSurface] = []
    private let bridge = NodeBridge()
    private let audioController = NativeVoiceAudioController()
    private weak var audioOwner: NotchSurface?

    private let panelWidth: CGFloat = 400
    private let panelHeight: CGFloat = 384

    private var globalMouseMonitor: Any?
    private var globalClickMonitor: Any?
    private var localMouseMonitor: Any?
    private var toggleHotKeyRef: EventHotKeyRef?
    private var voiceHotKeyRef: EventHotKeyRef?
    private var leftArrowHotKeyRef: EventHotKeyRef?
    private var rightArrowHotKeyRef: EventHotKeyRef?
    private var escapeHotKeyRef: EventHotKeyRef?
    private var muteHotKeyRef: EventHotKeyRef?
    private var settingsHotKeyRef: EventHotKeyRef?
    private var navHotKeysState: (active: Bool, arrows: Bool) = (false, false)
    private let hoverOpenDelay = 0.15
    private let hoverCloseDelay = 0.12

    // App preferences (edited from the in-notch settings screen), persisted in UserDefaults.
    private let defaults = UserDefaults.standard
    private var prefs: [String: Bool] {
        [
            "showOnAllScreens": defaults.object(forKey: "showOnAllScreens") as? Bool ?? true,
            "hoverToOpen": defaults.object(forKey: "hoverToOpen") as? Bool ?? true,
            "sounds": defaults.object(forKey: "sounds") as? Bool ?? true,
            "swipeToSwitch": defaults.object(forKey: "swipeToSwitch") as? Bool ?? false
        ]
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        sharedAppDelegate = self
        NSApp.setActivationPolicy(.accessory)

        registerCarbonGlobalHotKeys()

        bridge.start()
        reconcileSurfaces()
        setupEventMonitors()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(reconcileSurfaces),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        audioController.stop()
        if let hk1 = toggleHotKeyRef { UnregisterEventHotKey(hk1) }
        if let hk2 = voiceHotKeyRef { UnregisterEventHotKey(hk2) }
        setNavigationHotKeys(active: false, includeArrows: false)
        bridge.stop()
    }

    private func setNavigationHotKeys(active: Bool, includeArrows: Bool) {
        guard navHotKeysState != (active, includeArrows) else { return }
        navHotKeysState = (active, includeArrows)
        for ref in [leftArrowHotKeyRef, rightArrowHotKeyRef, escapeHotKeyRef, settingsHotKeyRef] { if let ref { UnregisterEventHotKey(ref) } }
        settingsHotKeyRef = nil
        leftArrowHotKeyRef = nil
        rightArrowHotKeyRef = nil
        escapeHotKeyRef = nil
        guard active else { return }
        RegisterEventHotKey(UInt32(kVK_Escape), 0, EventHotKeyID(signature: OSType(0x47424E35), id: 5), GetApplicationEventTarget(), 0, &escapeHotKeyRef)
        // ⌘, toggles the in-notch settings while the notch is open (even if it was opened by hover without focus).
        RegisterEventHotKey(UInt32(kVK_ANSI_Comma), UInt32(cmdKey), EventHotKeyID(signature: OSType(0x47424E37), id: 7), GetApplicationEventTarget(), 0, &settingsHotKeyRef)
        if includeArrows {
            RegisterEventHotKey(UInt32(kVK_LeftArrow), 0, EventHotKeyID(signature: OSType(0x47424E33), id: 3), GetApplicationEventTarget(), 0, &leftArrowHotKeyRef)
            RegisterEventHotKey(UInt32(kVK_RightArrow), 0, EventHotKeyID(signature: OSType(0x47424E34), id: 4), GetApplicationEventTarget(), 0, &rightArrowHotKeyRef)
        }
    }

    // MARK: - Carbon Global HotKeys (Works Across All Apps Without Accessibility Prompts)
    private func registerCarbonGlobalHotKeys() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), carbonHotKeyHandler, 1, &eventType, nil, nil)
        // ⌥Space toggles the notch; ⌘⇧G starts/ends a voice call.
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), EventHotKeyID(signature: OSType(0x47424E31), id: 1), GetApplicationEventTarget(), 0, &toggleHotKeyRef)
        RegisterEventHotKey(UInt32(kVK_ANSI_G), UInt32(cmdKey | shiftKey), EventHotKeyID(signature: OSType(0x47424E32), id: 2), GetApplicationEventTarget(), 0, &voiceHotKeyRef)
    }

    // MARK: - Screens & Hardware Notch Detection
    private func primaryMacScreen() -> NSScreen? {
        if #available(macOS 12.0, *) {
            if let notched = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) {
                return notched
            }
        }
        return NSScreen.screens.first ?? NSScreen.main
    }

    private func displayID(_ screen: NSScreen) -> CGDirectDisplayID {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    private func screen(for surface: NotchSurface) -> NSScreen? {
        NSScreen.screens.first { displayID($0) == surface.screenID }
    }

    private func detectHardwareNotchGeometry(for screen: NSScreen) -> (width: CGFloat, height: CGFloat) {
        if #available(macOS 12.0, *) {
            if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
                let gap = screen.frame.width - left.width - right.width
                let h = max(32, screen.safeAreaInsets.top)
                if gap > 100 && gap < 320 {
                    return (gap, h)
                }
            }
        }
        // Screens without a notch get a notch-shaped pouch sized to their menu bar.
        return (185, max(24, screen.frame.maxY - screen.visibleFrame.maxY))
    }

    private func panelFrame(on screen: NSScreen) -> NSRect {
        NSRect(x: screen.frame.midX - panelWidth / 2, y: screen.frame.maxY - panelHeight, width: panelWidth, height: panelHeight)
    }

    // Keeps exactly one surface per target screen (all screens, or just the main one per settings).
    @objc private func reconcileSurfaces() {
        let targets = prefs["showOnAllScreens"]! ? NSScreen.screens : [primaryMacScreen()].compactMap { $0 }
        let targetIDs = Set(targets.map(displayID))
        for surface in surfaces where !targetIDs.contains(surface.screenID) {
            if surface === audioOwner { audioController.stop() }
            surface.panel.orderOut(nil)
            surface.webView.configuration.userContentController.removeScriptMessageHandler(forName: "notchHost")
        }
        surfaces.removeAll { !targetIDs.contains($0.screenID) }
        for screen in targets {
            if let existing = surfaces.first(where: { $0.screenID == displayID(screen) }) {
                existing.panel.setFrame(panelFrame(on: screen), display: true)
                sendGeometry(to: existing)
            } else {
                surfaces.append(makeSurface(on: screen))
            }
        }
    }

    private func makeSurface(on screen: NSScreen) -> NotchSurface {
        let panel = NotchPanel(contentRect: panelFrame(on: screen), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 2)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.acceptsMouseMovedEvents = true
        panel.ignoresMouseEvents = true

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "notchHost")
        config.mediaTypesRequiringUserActionForPlayback = []
        config.setURLSchemeHandler(NotchSchemeHandler(bridge: bridge), forURLScheme: NotchSchemeHandler.scheme)
        config.websiteDataStore = .nonPersistent()

        let webView = NotchWebView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight), configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false

        panel.contentView = webView
        panel.orderFrontRegardless()
        if let url = URL(string: "\(NotchSchemeHandler.scheme)://app/?native=1") {
            webView.load(URLRequest(url: url))
        }
        return NotchSurface(screenID: displayID(screen), panel: panel, webView: webView)
    }

    private func sendGeometry(to surface: NotchSurface) {
        guard let screen = screen(for: surface) else { return }
        let geo = detectHardwareNotchGeometry(for: screen)
        surface.send(["action": "setNotchGeometry", "notchWidth": Int(geo.width), "notchHeight": Int(geo.height)])
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let surface = surfaces.first(where: { $0.webView === webView }) else { return }
        sendGeometry(to: surface)
        surface.send(["action": "setPrefs", "prefs": prefs])
    }

    // Surface on the screen under the cursor (where hotkeys act), falling back to the main one.
    private var activeSurface: NotchSurface? {
        let mouse = NSEvent.mouseLocation
        return surfaces.first { screen(for: $0)?.frame.contains(mouse) == true } ?? surfaces.first
    }

    private var callSurface: NotchSurface? { surfaces.first { $0.callPhase != "idle" } }
    private var openSurface: NotchSurface? { activeSurface.flatMap { $0.isOpen ? $0 : nil } ?? surfaces.first { $0.isOpen } }

    private func focus(_ surface: NotchSurface) {
        surface.panel.ignoresMouseEvents = false
        NSApp.activate(ignoringOtherApps: true)
        surface.panel.makeKeyAndOrderFront(nil)
        surface.panel.makeFirstResponder(surface.webView)
    }

    // MARK: - Hit-Testing, Hover & Cursor Gaze Monitors
    private func setupEventMonitors() {
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] _ in
            self?.handleMouseMove()
        }

        // Clicking outside an expanded notch collapses it (an active call keeps running in the collapsed bar).
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            guard let self = self else { return }
            let mouse = NSEvent.mouseLocation
            for surface in self.surfaces where surface.isOpen && !surface.hitRect.insetBy(dx: -10, dy: -10).contains(surface.localPoint(mouse)) {
                surface.send(["action": "collapse"])
            }
        }

        localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .rightMouseDown]) { [weak self] event in
            self?.handleMouseMove()
            return event
        }
    }

    private func handleMouseMove() {
        let mouse = NSEvent.mouseLocation
        for surface in surfaces {
            let local = surface.localPoint(mouse)
            let isInside = surface.hitRect.insetBy(dx: -10, dy: -6).contains(local)
            if surface.panel.ignoresMouseEvents == isInside {
                surface.panel.ignoresMouseEvents = !isInside
            }
            scheduleHover(surface, isInside: isInside, local: local)
            if surface.isOpen && local.y >= -20 && local.y <= panelHeight + 80 && local.x >= -120 && local.x <= panelWidth + 120 {
                surface.webView.evaluateJavaScript("window.__onNativeCursorMove && window.__onNativeCursorMove(\(Int(local.x)), \(Int(local.y)))", completionHandler: nil)
            }
        }
    }

    // Hover opens the notch after a short dwell; leaving closes it after a grace period (not while typing).
    private func scheduleHover(_ s: NotchSurface, isInside: Bool, local: NSPoint) {
        let nearOpenPouch = s.hitRect.insetBy(dx: -4, dy: -4).contains(local)
        // Only auto-close once the cursor has been over the open pouch (so ⌥Space with the mouse elsewhere stays open).
        if s.isOpen && nearOpenPouch { s.cursorVisitedOpenPouch = true }
        if !s.isOpen && isInside && prefs["hoverToOpen"]! {
            guard s.hoverWork == nil else { return }
            let work = DispatchWorkItem { [weak s] in
                guard let s = s, !s.isOpen else { return }
                s.hoverWork = nil
                s.openedByHover = true
                s.send(["action": "expand", "silent": true])
            }
            s.hoverWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + hoverOpenDelay, execute: work)
        } else if s.isOpen && !nearOpenPouch && !s.isTyping && (s.openedByHover || s.cursorVisitedOpenPouch) {
            guard s.hoverWork == nil else { return }
            let work = DispatchWorkItem { [weak s] in
                guard let s = s, s.isOpen, !s.isTyping else { return }
                s.hoverWork = nil
                s.send(["action": "collapse"])
            }
            s.hoverWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + hoverCloseDelay, execute: work)
        } else {
            s.hoverWork?.cancel()
            s.hoverWork = nil
        }
    }

    // ⌥Space: opens on the screen under the cursor with keyboard focus (type to message, Enter to call, ←/→ to switch).
    @objc func toggleNotchExpand() {
        guard let s = activeSurface else { return }
        if s.isOpen {
            s.send(["action": "collapse"])
        } else {
            reconcileSurfaces()
            focus(s)
            s.send(["action": "expand"])
        }
    }

    @objc func toggleVoiceCall() {
        guard let s = callSurface ?? activeSurface else { return }
        reconcileSurfaces()
        focus(s)
        s.send(["action": "toggleVoiceCall"])
    }

    func toggleSettings() {
        guard let s = openSurface else { return }
        focus(s)
        s.send(["action": "toggleSettings"])
    }

    func toggleMute() {
        callSurface?.send(["action": "toggleMute"])
    }

    // ⌘⇧M is only claimed while a call is in progress, so other apps keep it otherwise.
    private func updateMuteHotKey(active: Bool) {
        if active, muteHotKeyRef == nil {
            RegisterEventHotKey(UInt32(kVK_ANSI_M), UInt32(cmdKey | shiftKey), EventHotKeyID(signature: OSType(0x47424E36), id: 6), GetApplicationEventTarget(), 0, &muteHotKeyRef)
        } else if !active, let hk = muteHotKeyRef {
            UnregisterEventHotKey(hk)
            muteHotKeyRef = nil
        }
    }

    func cyclePrevBot() {
        openSurface?.send(["action": "prevBot"])
    }

    func cycleNextBot() {
        openSurface?.send(["action": "nextBot"])
    }

    func handleEscapeKey() {
        openSurface?.send(["action": "escape"])
    }

    @objc private func openDesktopApp() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Grok Bot.app"))
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    private func refreshGlobalHotKeys() {
        let open = openSurface
        setNavigationHotKeys(active: open != nil, includeArrows: open.map { !$0.isTyping } ?? false)
        updateMuteHotKey(active: callSurface != nil)
    }

    // MARK: - WKScriptMessageHandler & WKUIDelegate
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String,
              let surface = surfaces.first(where: { $0.webView === message.webView }) else { return }

        switch type {
        case "hitRect":
            let x = CGFloat((body["x"] as? NSNumber)?.doubleValue ?? 94)
            let y = CGFloat((body["y"] as? NSNumber)?.doubleValue ?? 0)
            let w = CGFloat((body["width"] as? NSNumber)?.doubleValue ?? 212)
            let h = CGFloat((body["height"] as? NSNumber)?.doubleValue ?? 56)
            surface.hitRect = NSRect(x: x, y: y, width: w, height: h)
            let wasOpen = surface.isOpen
            surface.isOpen = (body["isOpen"] as? Bool) ?? false
            surface.isTyping = (body["isTyping"] as? Bool) ?? false
            surface.callPhase = (body["callPhase"] as? String) ?? "idle"

            if surface.isOpen && !wasOpen {
                surface.panel.ignoresMouseEvents = false
                // Hover-open must not steal focus from the current app; hotkey/click opens take focus for typing.
                if !surface.openedByHover { focus(surface) }
            }
            if !surface.isOpen { surface.openedByHover = false }
            if surface.isOpen != wasOpen {
                surface.hoverWork?.cancel()
                surface.hoverWork = nil
                surface.cursorVisitedOpenPouch = false
            }

            refreshGlobalHotKeys()

        case "quit":
            NSApp.terminate(nil)

        case "setPref":
            guard let key = body["key"] as? String, prefs[key] != nil, let value = body["value"] as? Bool else { return }
            defaults.set(value, forKey: key)
            for s in surfaces { s.send(["action": "setPrefs", "prefs": prefs]) }
            if key == "showOnAllScreens" { reconcileSurfaces() }

        case "audioStart":
            audioOwner = surface
            audioController.webView = surface.webView
            audioController.start()

        case "audioPlay":
            if let b64 = body["base64"] as? String {
                audioController.playBase64Pcm16(b64)
            }

        case "audioStopPlayback":
            audioController.stopPlayback()

        case "audioSetMuted":
            audioController.setMuted((body["muted"] as? Bool) ?? false)

        case "audioStop":
            if surface === audioOwner { audioController.stop() }

        default:
            break
        }
    }

    @available(macOS 12.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        // Security: only the app's own UI may ever use the microphone.
        decisionHandler(origin.protocol == NotchSchemeHandler.scheme ? .grant : .deny)
    }

    // Security: the web view may never navigate away from the app's own UI.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.scheme == NotchSchemeHandler.scheme ? .allow : .cancel)
    }
}

// MARK: - Entry Point
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
