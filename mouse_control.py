import pyautogui
import sys
import os
import time
import tempfile

# Simple cross-process debounce to prevent rapid unintended clicks
COOLDOWN_SEC = float(os.environ.get("MOUSE_CLICK_COOLDOWN_SEC", "0.5"))
_STATE_FILE = os.path.join(tempfile.gettempdir(), "handsfree_mouse_last_click.txt")


def _click_allowed() -> bool:
    try:
        last = 0.0
        if os.path.exists(_STATE_FILE):
            with open(_STATE_FILE, "r") as f:
                content = f.read().strip()
                if content:
                    last = float(content)
        now = time.time()
        if (now - last) >= COOLDOWN_SEC:
            with open(_STATE_FILE, "w") as f:
                f.write(str(now))
            return True
        return False
    except Exception:
        # Fail open so we don't break primary functionality if filesystem is unavailable
        return True

action = sys.argv[1] if len(sys.argv) > 1 else None

if action == "click":
    if _click_allowed():
        pyautogui.click()
elif action == "move":
    x = int(sys.argv[2])
    y = int(sys.argv[3])
    pyautogui.moveTo(x, y)
elif action == "scrollup":
    pyautogui.scroll(100)
elif action == "scrolldown":
    pyautogui.scroll(-100)
elif action == "hotkey":
    # Example: python mouse_control.py hotkey ctrl enter
    keys = sys.argv[2:]
    if keys:
        pyautogui.hotkey(*keys)
elif action == "type":
    # Example: python mouse_control.py type 3+5=
    text = sys.argv[2] if len(sys.argv) > 2 else ""
    if text:
        pyautogui.write(text)
else:
    print("Unknown or missing action")