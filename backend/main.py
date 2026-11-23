import os
import uvicorn
from fastapi.staticfiles import StaticFiles
from api.index import app

# Mount current directory so index.html, style.css, and script.js are served automatically when running locally
app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    print("Starting CampusFix locally on http://127.0.0.1:8000 ...")
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
