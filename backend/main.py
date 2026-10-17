import os
import json
import time
from dotenv import load_dotenv
from google import genai
from google.genai import types
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from supabase import create_client, Client

# Telegram alert helper
from telegram_notifier import send_telegram_alert

# Load keys from the hidden .env file safely
load_dotenv()

# ==========================================
# Configuration & Setup
# ==========================================

app = FastAPI(title="CampusFix AI Backend")

# Allow frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize the NEW Gemini SDK
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
client = genai.Client(
    api_key=GEMINI_API_KEY, 
    http_options={'timeout': 5.0}
)

# Initialize Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

supabase: Optional[Client] = None
try:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
except Exception as e:
    print(f"Supabase connection warning: {e}")

# ==========================================
# Pydantic Schemas
# ==========================================

class ReportCreate(BaseModel):
    description: str
    location: str
    room: Optional[str] = ""
    photo: Optional[str] = None

class ReportStatusUpdate(BaseModel):
    status: str
    resolvedAt: Optional[int] = None

# ==========================================
# Helper Functions
# ==========================================

def triage_issue_with_ai(description: str) -> dict:
    """Uses the new Gemini SDK with retry logic for busy servers."""
    prompt = f"""
    Analyze this campus issue report: "{description}"
    
    Return ONLY a raw JSON object with the following keys:
    - "category": Must be one of ["Electrical", "Plumbing and water", "IT and Wi-Fi", "Lab equipment", "Furniture", "Cleanliness", "Civil and structure", "Safety and security", "General"].
    - "dept": The department responsible.
    - "severity": Integer from 1 to 5 (5 is most severe).
    - "safety": Boolean (true if there is an immediate physical hazard or danger, false otherwise).
    - "summary": A concise, one-sentence summary of the issue (max 70 characters).
    """
    
    max_retries = 2
    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model='gemini-3.8-flash',
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                ),
            )
            
            raw_text = response.text.strip()
            
            if raw_text.startswith("```"):
                raw_text = raw_text.strip("`")
                if raw_text.startswith("json"):
                    raw_text = raw_text[4:].strip()
                    
            return json.loads(raw_text)
            
        except Exception as e:
            if "503" in str(e) and attempt < max_retries - 1:
                wait_time = 2 ** attempt  # Waits 1 second, then 2 seconds
                print(f"Traffic spike detected. Retrying in {wait_time}s...")
                time.sleep(wait_time)
                continue
                
            print(f"AI Triage Fallback Triggered: {e}")
            return {
                "category": "General",
                "dept": "Campus admin office",
                "severity": 2,
                "safety": False,
                "summary": (description[:67] + "...") if len(description) > 70 else description
            }

# ==========================================
# API Endpoints
# ==========================================

@app.get("/api/reports")
def get_reports():
    """Fetches all reports from Supabase."""
    if not supabase:
        raise HTTPException(status_code=500, detail="Database credentials not configured.")
    try:
        response = supabase.table("reports").select("*").execute()
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/reports")
def create_report(report_in: ReportCreate):
    """Classifies issue with AI, checks for duplicates, saves report, and triggers alerts."""
    if not supabase:
        raise HTTPException(status_code=500, detail="Database credentials not configured.")

    # 1. AI Classification
    ai_data = triage_issue_with_ai(report_in.description)
    print(f"--> AI Triage Result: {ai_data}")
    
    # 2. Duplicate Check: Search for unresolved issues at the same location & category
    try:
        existing = (
            supabase.table("reports")
            .select("*")
            .eq("location", report_in.location)
            .eq("category", ai_data["category"])
            .neq("status", "Resolved")
            .execute()
        )
    except Exception as e:
        print(f"Duplicate lookup error: {e}")
        existing = None

    current_time = int(time.time() * 1000)

    # If it's an existing issue, increment report count
    if existing and existing.data:
        dup = existing.data[0]
        new_count = dup.get("reports", 1) + 1
        supabase.table("reports").update({"reports": new_count}).eq("id", dup["id"]).execute()
        dup["reports"] = new_count
        print(f"--> Merged into existing issue {dup['id']}. Total reports: {new_count}")

        if ai_data["safety"] or ai_data["severity"] >= 4:
            priority_str = "CRITICAL" if ai_data["severity"] == 5 else "HIGH"
            location_label = f"{report_in.location} ({report_in.room})" if report_in.room else report_in.location
            send_telegram_alert(
                issue_id=dup["id"],
                category=ai_data["category"],
                priority=f"{priority_str} (Escalated: {new_count} reports)",
                location=location_label,
                description=ai_data["summary"],
                photo_b64=report_in.photo
            )
        return {"merged": True, "report": dup}
    
    # 3. Create New Ticket
    new_id = f"CF-{int(time.time()) % 100000}" 
    new_report = {
        "id": new_id,
        "summary": ai_data["summary"],
        "category": ai_data["category"],
        "dept": ai_data["dept"],
        "severity": ai_data["severity"],
        "safety": ai_data["safety"],
        "location": report_in.location,
        "room": report_in.room,
        "reports": 1,
        "verifications": 0,
        "status": "Reported",
        "createdAt": current_time,
        "resolvedAt": None,
        "photo": report_in.photo,
        "description": report_in.description
    }
    
    try:
        supabase.table("reports").insert(new_report).execute()
        print(f"--> Saved new ticket {new_id} to Supabase")
    except Exception as e:
        print(f"Supabase Insert Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save report: {e}")

    # 4. Telegram Alert for High Urgency or Safety Risks
    if ai_data["safety"] or ai_data["severity"] >= 4:
        print(f"--> Triggering Telegram alert for {new_id}...")
        priority_str = "CRITICAL" if ai_data["severity"] == 5 else "HIGH"
        location_label = f"{report_in.location} ({report_in.room})" if report_in.room else report_in.location
        send_telegram_alert(
            issue_id=new_id,
            category=ai_data["category"],
            priority=priority_str,
            location=location_label,
            description=ai_data["summary"],
            photo_b64=report_in.photo
        )
    else:
        print("--> Normal priority issue. Skipping Telegram alert.")

    return {"merged": False, "report": new_report}

@app.patch("/api/reports/{report_id}")
def update_report_status(report_id: str, update_data: ReportStatusUpdate):
    """Updates status and resolution timestamp."""
    if not supabase:
        raise HTTPException(status_code=500, detail="Database credentials not configured.")

    payload = {"status": update_data.status}
    if update_data.status == "Resolved":
        payload["resolvedAt"] = update_data.resolvedAt or int(time.time() * 1000)
    else:
        payload["resolvedAt"] = None

    try:
        response = supabase.table("reports").update(payload).eq("id", report_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Report not found")
        return response.data[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/reports/{report_id}/verify")
def verify_report(report_id: str):
    """Increments the verification count for a resolved issue."""
    if not supabase:
        raise HTTPException(status_code=500, detail="Database credentials not configured.")
    
    try:
        res = supabase.table("reports").select("verifications, status").eq("id", report_id).execute()
        if not res.data:
            raise HTTPException(status_code=404, detail="Report not found")
            
        current_count = res.data[0].get("verifications") or 0
        new_count = current_count + 1
        
        payload = {"verifications": new_count}
        if new_count >= 3:
            payload["status"] = "Verified Closed"
            
        updated = supabase.table("reports").update(payload).eq("id", report_id).execute()
        return updated.data[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/reports/{report_id}/flag")
def flag_report(report_id: str):
    """Flags a fake resolution, reopening the ticket with critical severity."""
    if not supabase:
        raise HTTPException(status_code=500, detail="Database credentials not configured.")
    try:
        payload = {
            "status": "In progress",
            "verifications": 0,                             
            "severity": 5,  
            "resolvedAt": None
        }
        updated = supabase.table("reports").update(payload).eq("id", report_id).execute()
        return updated.data[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
# ==========================================
# Frontend Static Files Mount
# ==========================================

# Mount current directory so index.html, style.css, and script.js are served automatically
app.mount("/", StaticFiles(directory="../frontend", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
