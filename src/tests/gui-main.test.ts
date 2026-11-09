import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  isAllowedNavigation,
  parseGuiArgs,
  shouldStartGui,
} from "../gui/main.ts";

test("GUI main: parses --port in both supported forms", () => {
  assert.deepEqual(parseGuiArgs([]), { help: false });
  assert.deepEqual(parseGuiArgs(["--help"]), { help: true });
  assert.deepEqual(parseGuiArgs(["-h"]), { help: true });
  assert.deepEqual(parseGuiArgs(["--port", "8123"]), {
    help: false,
    port: 8123,
  });
  assert.deepEqual(parseGuiArgs(["--port=8123"]), {
    help: false,
    port: 8123,
  });
  assert.deepEqual(parseGuiArgs(["--port=8123", "--help"]), {
    help: true,
    port: 8123,
  });
});

test("GUI main: rejects invalid or missing port values", () => {
  assert.throws(() => parseGuiArgs(["--port"]), /requires a value/);
  assert.throws(() => parseGuiArgs(["--port", "0"]), /Invalid port/);
  assert.throws(() => parseGuiArgs(["--port", "70000"]), /Invalid port/);
  assert.throws(() => parseGuiArgs(["--port=abc"]), /Invalid port/);
  assert.throws(() => parseGuiArgs(["--port", "1.5"]), /Invalid port/);
});

test("GUI main: ignores unrelated flags", () => {
  assert.deepEqual(parseGuiArgs(["--tui", "--server", "--dry-run"]), {
    help: false,
  });
});

test("GUI main: navigation stays on the dashboard origin", () => {
  const origin = "http://127.0.0.1:7936";
  assert.equal(isAllowedNavigation(`${origin}/admin/`, origin), true);
  assert.equal(isAllowedNavigation(`${origin}/admin/users`, origin), true);
  assert.equal(isAllowedNavigation("about:blank", origin), true);
  assert.equal(isAllowedNavigation("data:text/html,test", origin), true);
  assert.equal(isAllowedNavigation("http://127.0.0.1:9999/admin/", origin), false);
  assert.equal(isAllowedNavigation("https://127.0.0.1:7936/admin/", origin), false);
  assert.equal(isAllowedNavigation("https://example.com/", origin), false);
  assert.equal(isAllowedNavigation("javascript:alert(1)", origin), false);
  assert.equal(isAllowedNavigation("not a url", origin), false);
});

test("GUI main: error pages escape untrusted text", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")&'y'</script>`),
    "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;",
  );
});

test("GUI main: autostart is opt-in", () => {
  const previous = process.env.QWENPROXY_GUI_AUTOSTART;
  delete process.env.QWENPROXY_GUI_AUTOSTART;
  try {
    // Under the test runner argv[1] is the test file, not this module.
    assert.equal(shouldStartGui(), false);
    process.env.QWENPROXY_GUI_AUTOSTART = "1";
    assert.equal(shouldStartGui(), true);
  } finally {
    if (previous === undefined) {
      delete process.env.QWENPROXY_GUI_AUTOSTART;
    } else {
      process.env.QWENPROXY_GUI_AUTOSTART = previous;
    }
  }
});
