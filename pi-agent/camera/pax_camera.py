#!/usr/bin/env python3
"""
PAX webcam streamer for a USB (UVC) webcam plugged into the Raspberry Pi.

Serves the camera as MJPEG over plain HTTP, which every browser can show in a
normal <img> tag with no plugins:

  GET /stream     multipart/x-mixed-replace MJPEG stream
  GET /snapshot   one JPEG frame
  GET /status     {"ok": true, "device": "/dev/video0", "present": true, "clients": 1}

The webcam is only opened while at least one viewer is connected. When the last
viewer closes the stream (the app's "camera off" button, or the popup closing
after a move), ffmpeg is stopped and the camera's LED goes off. Nothing records
or stores video.

Run by hand:     python3 pax_camera.py --device /dev/video0 --port 8780
As a service:    sudo ./install-camera.sh
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BOUNDARY = "paxframe"
SOI = b"\xff\xd8"
EOI = b"\xff\xd9"


class Camera:
    """One ffmpeg process shared by every viewer, started on demand."""

    def __init__(self, device: str, size: str, fps: int, quality: int) -> None:
        self.device = device
        self.size = size
        self.fps = fps
        self.quality = quality
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._frame: bytes | None = None
        self._seq = 0
        self._clients = 0
        self._proc: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None
        self._stop_timer: threading.Timer | None = None
        self.error: str | None = None

    @property
    def present(self) -> bool:
        return os.path.exists(self.device)

    @property
    def clients(self) -> int:
        return self._clients

    def acquire(self) -> None:
        with self._lock:
            self._clients += 1
            if self._stop_timer:
                self._stop_timer.cancel()
                self._stop_timer = None
            if self._proc is None or self._proc.poll() is not None:
                self._start_locked()

    def release(self) -> None:
        with self._lock:
            self._clients = max(0, self._clients - 1)
            if self._clients == 0 and self._stop_timer is None:
                # Short grace period so a page reload doesn't power-cycle the camera.
                self._stop_timer = threading.Timer(3.0, self._stop_if_idle)
                self._stop_timer.daemon = True
                self._stop_timer.start()

    def _stop_if_idle(self) -> None:
        with self._lock:
            self._stop_timer = None
            if self._clients == 0:
                self._stop_locked()

    def _start_locked(self) -> None:
        self._frame = None
        self.error = None
        if not self.present:
            self.error = f"No webcam found at {self.device}"
            return
        # Ask the camera for MJPEG first (most UVC webcams encode it in hardware,
        # so the Pi does almost no work); ffmpeg re-encodes only if it can't.
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "v4l2", "-input_format", "mjpeg",
            "-video_size", self.size, "-framerate", str(self.fps),
            "-i", self.device,
            "-f", "mjpeg", "-q:v", str(self.quality), "-r", str(self.fps), "-",
        ]
        try:
            self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        except OSError as exc:
            self.error = f"Could not start ffmpeg: {exc}"
            self._proc = None
            return
        print(f"[camera] started {self.device} {self.size}@{self.fps}", flush=True)
        self._reader = threading.Thread(target=self._read_frames, args=(self._proc,), daemon=True)
        self._reader.start()

    def _stop_locked(self) -> None:
        proc, self._proc = self._proc, None
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
            print("[camera] stopped (no viewers)", flush=True)
        self._frame = None

    def _read_frames(self, proc: subprocess.Popen) -> None:
        buf = b""
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                start = buf.find(SOI)
                if start < 0:
                    buf = b""
                    break
                end = buf.find(EOI, start + 2)
                if end < 0:
                    buf = buf[start:]
                    break
                frame = buf[start:end + 2]
                buf = buf[end + 2:]
                with self._cond:
                    self._frame = frame
                    self._seq += 1
                    self._cond.notify_all()
        err = b""
        if proc.stderr is not None:
            try:
                err = proc.stderr.read() or b""
            except OSError:
                pass
        with self._cond:
            if self._proc is proc:
                self._proc = None
                msg = err.decode(errors="replace").strip().splitlines()
                self.error = msg[-1] if msg else "Webcam stream ended"
                print(f"[camera] ffmpeg exited: {self.error}", flush=True)
            self._cond.notify_all()

    def wait_frame(self, last_seq: int, timeout: float = 5.0) -> tuple[int, bytes | None]:
        with self._cond:
            deadline = time.monotonic() + timeout
            while self._seq == last_seq:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or (self._proc is None and self.error):
                    return self._seq, None
                self._cond.wait(remaining)
            return self._seq, self._frame


def make_handler(cam: Camera):
    class Handler(BaseHTTPRequestHandler):
        server_version = "PAXCamera/1"

        def log_message(self, fmt, *args):  # quiet: the journal gets our own lines
            pass

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")

        def _json(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/status":
                self._json(200, {
                    "ok": cam.present and not cam.error,
                    "device": cam.device,
                    "present": cam.present,
                    "clients": cam.clients,
                    "error": cam.error,
                })
            elif path == "/snapshot":
                self._snapshot()
            elif path == "/stream":
                self._stream()
            else:
                self._json(404, {"ok": False, "error": "not found"})

        def _snapshot(self):
            cam.acquire()
            try:
                _, frame = cam.wait_frame(-1 if cam._frame is None else cam._seq, timeout=6)
            finally:
                cam.release()
            if not frame:
                self._json(503, {"ok": False, "error": cam.error or "No frame from webcam"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(frame)))
            self._cors()
            self.end_headers()
            self.wfile.write(frame)

        def _stream(self):
            if not cam.present:
                self._json(503, {"ok": False, "error": f"No webcam found at {cam.device}"})
                return
            cam.acquire()
            try:
                self.send_response(200)
                self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY}")
                self.send_header("Connection", "close")
                self._cors()
                self.end_headers()
                seq = -1
                misses = 0
                while True:
                    seq, frame = cam.wait_frame(seq, timeout=5)
                    if frame is None:
                        misses += 1
                        if cam.error or misses >= 3:
                            break
                        continue
                    misses = 0
                    self.wfile.write(
                        f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(frame)}\r\n\r\n".encode()
                    )
                    self.wfile.write(frame)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                cam.release()

    return Handler


def main() -> None:
    p = argparse.ArgumentParser(description="PAX webcam MJPEG streamer")
    p.add_argument("--device", default="/dev/video0", help="V4L2 device of the USB webcam")
    p.add_argument("--port", type=int, default=8780, help="HTTP port (match the app's camera port)")
    p.add_argument("--size", default="640x480", help="Capture resolution, e.g. 640x480 or 1280x720")
    p.add_argument("--fps", type=int, default=15, help="Frames per second")
    p.add_argument("--quality", type=int, default=6, help="JPEG quality 2 (best) – 31 (smallest)")
    args = p.parse_args()

    if shutil.which("ffmpeg") is None:
        print("error: ffmpeg is not installed (sudo apt install ffmpeg)", file=sys.stderr)
        sys.exit(1)

    cam = Camera(args.device, args.size, args.fps, args.quality)
    server = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(cam))
    server.daemon_threads = True
    print(
        f"[camera] serving {args.device} on http://0.0.0.0:{args.port}/stream "
        f"({'found' if cam.present else 'NOT plugged in yet'})",
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        with cam._lock:
            cam._stop_locked()


if __name__ == "__main__":
    main()
