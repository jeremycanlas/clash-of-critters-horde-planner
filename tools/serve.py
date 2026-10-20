"""Serve this folder to the phone on the LAN, with nothing cached.

python -m http.server sends no Cache-Control at all, so a phone keeps its own
copy of every module and shows you the version from before your last edit --
which during a session of "try it on the phone, change it, try again" is most
of the tries. Every response here says no-store.

This is only about the app's *files*. Saved formations live in localStorage,
which is a different store: no cache header touches it and no reload clears it.
"""
import functools, http.server, io, os, socket, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


class H(http.server.SimpleHTTPRequestHandler):
    # Keep-alive. Under HTTP/1.0 every one of a drafter load's 242 sprites is a
    # new connection, and a few browsers loading together (the screen sweep)
    # ran Windows out of sockets: ERR_NO_BUFFER_SPACE, on a server doing nothing.
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    # A Windows checkout has CRLF line endings: a byte a line that the live site,
    # serving the repo's LF, never sends. Hand text out as LF so the screen
    # sweep's weight budgets measure what a phone actually downloads.
    TEXT = ('.html', '.css', '.js', '.mjs', '.json', '.svg')

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, 'index.html')
        if not path.endswith(self.TEXT) or not os.path.isfile(path):
            return super().send_head()
        with open(path, 'rb') as f:
            body = f.read().replace(b'\r\n', b'\n')
        self.send_response(200)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        return io.BytesIO(body)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


print(f'http://{lan_ip()}:{PORT}/   (nothing cached)')
class Server(http.server.ThreadingHTTPServer):
    # The default backlog is 5, and one drafter load asks for 242 sprites at
    # once. Several browsers loading together (the screen sweep does) had
    # connections refused while the server was idle.
    request_queue_size = 256
    daemon_threads = True


Server(
    ('0.0.0.0', PORT),
    functools.partial(H, directory=os.getcwd()),
).serve_forever()
