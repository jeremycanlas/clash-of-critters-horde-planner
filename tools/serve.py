"""Serve this folder to the phone on the LAN, with nothing cached.

python -m http.server sends no Cache-Control at all, so a phone keeps its own
copy of every module and shows you the version from before your last edit --
which during a session of "try it on the phone, change it, try again" is most
of the tries. Every response here says no-store.

This is only about the app's *files*. Saved formations live in localStorage,
which is a different store: no cache header touches it and no reload clears it.
"""
import functools, http.server, os, socket, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()


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
http.server.ThreadingHTTPServer(
    ('0.0.0.0', PORT),
    functools.partial(H, directory=os.getcwd()),
).serve_forever()
