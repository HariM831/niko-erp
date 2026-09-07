# Weighbridge cameras

A relay between the mill's IP cameras and niko, for the cabin desktop.

## Why this exists at all

niko is served over HTTPS from a droplet. The cameras are plain HTTP on the farm
LAN behind digest auth. A browser cannot bridge that, and each of these is fatal
on its own:

- an HTTPS page may not fetch `http://` — mixed content, no override
- the cameras send no CORS headers, so even over HTTPS the reply is unreadable
- an `<img>` tag cannot perform digest authentication
- no browser plays RTSP, so the best stream is the least reachable

This process does the fetching instead. Camera traffic never touches the
browser's rules, and the page talks to `127.0.0.1`, which counts as a
trustworthy origin even from an HTTPS page.

## It must run on the desktop the browser is on

Not "a machine on the LAN". A relay at `http://192.168.1.20:9099` is ordinary
mixed content to the page and is blocked exactly like the camera was. Only
`localhost` / `127.0.0.1` escapes that rule.

## Setup

Needs Node 18 or newer, and nothing else — no `npm install`.

```bash
cp cameras.example.json cameras.json     # then fill in hosts and passwords
node weighbridge-cameras.mjs
```

Then open <http://127.0.0.1:9099/> on that desktop. It shows a live still from
every configured camera with a Refresh button.

**Look at a number plate in those pictures before buying anything.** Plate
legibility is decided by where the camera points and what lens is on it, far
more than by its resolution: a 4K camera 10 m away at a wide angle gives a plate
about 40 px across and no amount of megapixels rescues that, while a 2 MP camera
framed on where vehicles stop reads easily.

## Finding the snapshot path

The default suits Hikvision and most cameras that imitate it. Port 8000 in the
old WBSoftCAM settings is Hikvision's SDK port, not the web one — snapshots are
on port 80. To check a camera by hand:

```bash
curl -u admin:PASSWORD --digest "http://192.168.1.65/ISAPI/Streaming/channels/101/picture" -o test.jpg
```

Other makes: Dahua `/cgi-bin/snapshot.cgi`, Axis `/axis-cgi/jpg/image.cgi`,
generic ONVIF `/onvif/snapshot`. Put whichever works in `path`.

## Running it all day

The cabin desktop should start it at login. Simplest on Windows — a shortcut in
`shell:startup` to:

```
node C:\path\to\weighbridge-cameras.mjs
```

For something that restarts itself after a crash or a power cut, install it as a
service with [NSSM](https://nssm.cc/) pointing at the same command.

## Security

- Binds to `127.0.0.1` only. Nothing off that desktop can ask it for a picture.
- Answers cross-origin only to the niko origins listed in the script.
- `/cameras` returns names and labels; passwords stay in the process and are
  never sent to the browser.
- `cameras.json` holds camera passwords in plain text — it is gitignored, and it
  should be readable only by the account that runs the service.

## Nothing depends on it

If the relay is not running, niko falls back to the USB webcam and the operator
can still weigh, record and print. A camera is evidence attached to a weighment;
it has never been allowed to stop one.
