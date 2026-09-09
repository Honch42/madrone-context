import os
import threading
import uvicorn
import webview
from server import app

def start_server():
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="error")

if __name__ == "__main__":
    t = threading.Thread(target=start_server, daemon=True)
    t.start()
    
    app_url = "http://localhost:8000/static/index.html"
    
    # Create a frameless macOS window that acts like a native app
    window = webview.create_window(
        "Proactive Context", 
        app_url, 
        width=1400, 
        height=900, 
        frameless=True,
        easy_drag=False  # We use our own -webkit-app-region: drag CSS
    )
    
    webview.start(debug=True)
