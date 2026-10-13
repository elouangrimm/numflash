"""Phone-sized browser smoke test: mock WebUSB calculator + fake GitHub release.
(The WASM linker can't run here, so install itself is covered by the Node tests.)"""
import json, re, subprocess, time, hashlib, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

mock = open(os.path.join(ROOT, 'test/mock-device.mjs')).read()
mock = re.sub(r'^export ', '', mock, flags=re.M)
init = mock + """
window.Buffer = { from: (b) => ({ toString: () => [...b].map(x => x.toString(16).padStart(2,'0')).join('') }) };
const __m = makeMock({ log: [] });
window.__mock = __m;
Object.defineProperty(navigator, 'usb', { value: { getDevices: async () => [__m.device], requestDevice: async () => __m.device, addEventListener() {} }, configurable: true });
"""

names = {1: 'NumPlay_en.nwa', 2: 'NumPlay_fr.nwa', 3: 'NumPlay_matrices.nwa', 4: 'NumPlay_hidden.nwa', 5: 'NumPlay_de.nwa', 6: 'celeste.nwa', 7: 'tetris.nwa'}
sizes = {1: 300_000, 2: 300_000, 3: 310_000, 4: 305_000, 5: 300_000, 6: 2_600_000, 7: 140_000}
blobs = {i: bytes([(i * 31 + j) & 0xff for j in range(sizes[i])]) for i in names}
release = {'tag_name': 'v1.10.0', 'name': 'NumPlay 1.10.0', 'published_at': '2026-10-13T08:00:00Z', 'html_url': 'https://github.com/Mason363/NumPlay/releases/tag/v1.10.0',
  'assets': [{'id': i, 'name': names[i], 'size': len(b), 'url': f'https://api.github.com/repos/Mason363/NumPlay/releases/assets/{i}',
              'browser_download_url': f'https://github.com/x/{names[i]}', 'digest': 'sha256:' + hashlib.sha256(b).hexdigest(), 'updated_at': ''} for i, b in blobs.items()]}

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.add_init_script(init)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    page.route('https://api.github.com/repos/Mason363/NumPlay/releases/latest', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(release), headers={'access-control-allow-origin': '*'}))
    def asset(route):
        i = int(route.request.url.rsplit('/', 1)[1]); route.fulfill(status=200, body=blobs[i], headers={'access-control-allow-origin': '*', 'content-type': 'application/octet-stream'})
    page.route(re.compile(r'https://api\.github\.com/repos/Mason363/NumPlay/releases/assets/\d+'), asset)
    page.on('dialog', lambda d: d.accept())

    page.goto('http://localhost:8765/index.html'); page.wait_for_selector('#list .item')
    # default view: 4 launcher variants + big games only (de + tetris hidden)
    assert page.locator('#list .item').count() == 5, page.locator('#list .item').count()
    assert 'hidden' in page.locator('#list li.muted').inner_text() and '2 more' in page.locator('#list li.muted').inner_text()
    assert page.locator('#relTag').inner_text() == 'v1.10.0'
    # sorted: NumPlay first, then by size
    first = page.locator('#list .item .name').first.inner_text(); assert first.startswith('NumPlay'), first
    # mock calculator auto-connected
    page.wait_for_selector('#connect.on'); print('pill:', page.locator('#connectLabel').inner_text())
    assert 'Extra-apps space: 6.0 MB' in page.locator('#spaceText').inner_text(), page.locator('#spaceText').inner_text()
    print('calc:', page.locator('#calcName').inner_text(), '|', page.locator('#calcSub').inner_text())
    # setup banner appears because no wasm is deployed in this checkout
    assert page.locator('#setup').is_visible(); print('setup banner:', page.locator('#missingList').inner_text())
    # settings: show every file
    page.click('#openSettings'); page.check('#optAll'); page.click('#closeSettings')
    assert page.locator('#list .item').count() == 7
    page.click('[data-filter=big]'); assert page.locator('#list .item').count() == 1
    page.click('[data-filter=small]'); assert page.locator('#list .item').count() == 6
    page.click('[data-filter=all]'); page.click('#openSettings'); page.uncheck('#optAll'); page.click('#closeSettings')
    assert page.locator('#list .item').count() == 5
    # add two apps
    page.locator('#list .item .act').nth(0).click(); page.locator('#list .item .act').nth(1).click()
    assert page.locator('#queueBar').is_visible(); print('queue:', page.locator('#qCount').inner_text(), page.locator('#qSize').inner_text())
    # save offline (downloads through the CORS path + sha256 check)
    page.click('#saveAll'); page.wait_for_function("document.querySelectorAll('#list .badge.ok').length === 5", timeout=15000)
    print('offline badges:', page.locator('#list .badge.ok').count())
    # selection survives a reload
    page.reload(); page.wait_for_selector('#list .item'); page.wait_for_selector('#queueBar:not([hidden])')
    assert page.locator('#qCount').inner_text().startswith('2'), page.locator('#qCount').inner_text()
    # own file
    page.set_input_files('#pickNwa', files=[{'name': 'mygame.nwa', 'mimeType': 'application/octet-stream', 'buffer': b'\x7fELF' + b'\0' * 2000}])
    assert page.locator('#mineList .item').count() == 1
    # review without wasm -> clear message instead of a crash
    msgs = []; page.on('dialog', lambda d: msgs.append(d.message))
    page.click('#review'); page.wait_for_timeout(300)
    print('review w/o wasm ->', msgs[-1][:70] if msgs else 'no dialog')
    page.screenshot(path='/tmp/ui-home.png')
    b.close()
srv.terminate()
print('JS errors:', errors or 'none')
assert not errors
print('UI smoke test passed')
