import os
import base64
import requests
from dotenv import load_dotenv

# Load keys from .env file
load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

def send_telegram_alert(issue_id: str, category: str, priority: str, location: str, description: str, photo_b64: str = None):
    caption = (
        f"🚨 NEW CAMPUS ISSUE #{issue_id}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"⚠️ Priority: {priority}\n"
        f"📂 Category: {category}\n"
        f"📍 Location: {location}\n"
        f"📝 Details: {description}"
    )

    try:
        if photo_b64 and "," in photo_b64:
            # Strip base64 metadata prefix (e.g. data:image/jpeg;base64,...)
            raw_b64 = photo_b64.split(",", 1)[1]
            img_bytes = base64.b64decode(raw_b64)
            
            url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"
            files = {"photo": ("hazard.jpg", img_bytes, "image/jpeg")}
            data = {"chat_id": TELEGRAM_CHAT_ID, "caption": caption}
            res = requests.post(url, data=data, files=files, timeout=8)
        else:
            url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
            res = requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": caption}, timeout=5)

        print(f"Telegram status: {res.status_code}")
    except Exception as e:
        print(f"Telegram alert error: {e}")
