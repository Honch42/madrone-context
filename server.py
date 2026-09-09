import os
import json
import keyring
import datetime
import traceback
import glob
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from plugins import get_active_plugins

raw = keyring.get_password("AntiGravity", "gemini-api-key-Collective")
api_key = raw
try:
    data = json.loads(raw)
    api_key = data.get("api_key", raw)
except:
    pass

client = genai.Client(api_key=api_key)
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
app.mount("/static", StaticFiles(directory=frontend_dir), name="static")

ARCHIVE_DIR = "/Users/honchpersonal/Documents/Anti-gravity/Context /archives"
os.makedirs(ARCHIVE_DIR, exist_ok=True)
MASTER_DOSSIER_PATH = os.path.join(ARCHIVE_DIR, "master_dossier.md")

PERSONA_PROMPTS = {
    "socratic": "You are an advanced, empathetic, and Socratic interviewer. Your goal is to extract the underlying 'why' behind the user's actions, decisions, and feelings by asking progressively deeper questions.",
    "5whys": "You are a sharp, analytical root-cause investigator using the '5 Whys' framework. Your goal is to aggressively drill down into the user's statements to find the absolute fundamental root cause of any problem or feeling.",
    "grow": "You are an executive coach utilizing the GROW model (Goal, Reality, Options, Will). Guide the user structurally from defining their goals, assessing their current reality, brainstorming options, and committing to action.",
    "empathetic": "You are a warm, entirely non-judgmental, active listener. Your primary goal is to provide a safe space, validate the user's emotions, and let them vent or process feelings without aggressively pushing for solutions."
}

BASE_SYSTEM_PROMPT = """
{persona_instruction}
You are conducting a live verbal interview. You will receive an audio clip of the user speaking.
Listen carefully to what they say, note any vocal cues, and then respond.

CRITICAL INSTRUCTION: You must ALWAYS output your response as a valid JSON object. You have exactly three options for your JSON output:

Option 1 (Default): A normal conversational turn.
{
  "transcript": "The exact text transcription of what the user said in the audio",
  "question": "Your concise follow-up question or conversational response"
}

Option 2 (Tool Trigger - Past Context):
ONLY use this if the user EXPLICITLY asks to "catch me up", "what did I miss", or explicitly asks for past/historical context.
Return EXACTLY this JSON:
{"tool": "fetch_rearward_context", "transcript": "[What the user said]"}

Option 3 (Tool Trigger - Future Context):
ONLY use this if the user EXPLICITLY asks "what's coming up", "what's on my calendar", "what are my deadlines", or explicitly asks for future/upcoming context.
Return EXACTLY this JSON:
{"tool": "fetch_forward_context", "transcript": "[What the user said]"}
"""

def fetch_rearward_context() -> str:
    print("TOOL CALLED (MANUAL ROUTING): fetch_rearward_context", flush=True)
    sync_state_path = os.path.join(ARCHIVE_DIR, "sync_state.json")
    if os.path.exists(sync_state_path):
        try:
            with open(sync_state_path, "r") as f:
                last_sync = json.load(f).get("last_sync", "2026-09-01T00:00:00Z")
        except:
            last_sync = (datetime.datetime.utcnow() - datetime.timedelta(days=1)).isoformat() + "Z"
    else:
        last_sync = (datetime.datetime.utcnow() - datetime.timedelta(days=1)).isoformat() + "Z"
        
    plugins = get_active_plugins()
    results = []
    for p in plugins:
        try:
            res = p.fetch_rearward_context(last_sync)
            results.append(f"--- {p.name} ---\n{res}")
        except Exception as e:
            results.append(f"--- {p.name} ---\nError: {str(e)}")
            
    context_data = "\n\n".join(results)
    
    # Do NOT update sync_state.json here. 
    # We want the user to be able to query the same time window multiple times in one session.
    # It will be updated when the session concludes.
        
    return context_data

def fetch_forward_context() -> str:
    print("TOOL CALLED (MANUAL ROUTING): fetch_forward_context", flush=True)
    results = []
    
    from plugins.google_workspace_plugin import GoogleWorkspacePlugin
    gwp = GoogleWorkspacePlugin()
    
    try:
        res = gwp.fetch_forward_context()
        results.append(f"--- Google Workspace (Forward) ---\n{res}")
    except Exception as e:
        results.append(f"--- Google Workspace (Forward) ---\nError: {str(e)}")
        
    return "\n\n".join(results)

@app.websocket("/ws/orchestrator")
async def websocket_orchestrator(websocket: WebSocket):
    await websocket.accept()
    
    # Wait for init message to get persona
    init_msg = await websocket.receive_json()
    persona_key = init_msg.get("persona", "socratic")
    persona_instruction = PERSONA_PROMPTS.get(persona_key, PERSONA_PROMPTS["socratic"])
    
    dossier_context = ""
    if os.path.exists(MASTER_DOSSIER_PATH):
        with open(MASTER_DOSSIER_PATH, "r") as f:
            dossier_context = f.read()
            
    system_instruction = BASE_SYSTEM_PROMPT.replace("{persona_instruction}", persona_instruction)
    if dossier_context:
        system_instruction += f"\n\nHere is the user's Master Dossier (past context from previous sessions):\n{dossier_context}\nUse this context to inform your Option 1 questions. Do not bring it up awkwardly, but use it to be proactive."

    chat = client.aio.chats.create(
        model="gemini-3.6-flash",
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=0.7,
            response_mime_type="application/json"
        )
    )
    
    try:
        if init_msg.get("deep_dive"):
            context = init_msg.get("context", "")
            prompt = f"The user has just re-entered the interview specifically to investigate a behavioral discrepancy between their words and their body language from the previous session. Here is the discrepancy you noted: '{context}'. Please immediately ask them a piercing, direct question (using Option 1 JSON format) about why their physical body language did not match their verbal confidence. For the transcript field, put '[Deep Dive Initiated]'."
        elif dossier_context:
            prompt = "The user has just started a new session. Based on their Master Dossier, give a highly contextual, proactive opening question. Use Option 1 JSON format. For the transcript field, put 'Session Started (Context Loaded)'."
        else:
            prompt = "The user has just started an ad-hoc session. Give a concise, welcoming first question about what's on their mind. Use Option 1 JSON format. For the transcript field, put 'Session Started'."
            
        initial_response = await chat.send_message(prompt)
        try:
            parsed = json.loads(initial_response.text)
            q_text = parsed.get("question", "Hello! Let's get started.")
        except:
            q_text = "Hello! Let's get started."
        await websocket.send_json({"type": "question", "text": q_text, "transcript": ""})
    except Exception as e:
        await websocket.send_json({"type": "question", "text": f"[Error Init]: {str(e)}", "transcript": ""})
    
    current_mime = "audio/mp4"
    
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
                
            if "text" in message:
                try:
                    data = json.loads(message["text"])
                    if data.get("type") == "log_error":
                        print(f"FRONTEND ERROR: {data.get('text')}", flush=True)
                    elif data.get("type") == "audio_meta":
                        current_mime = data.get("mime_type", "audio/mp4")
                    elif data.get("type") == "end_session":
                        try:
                            list_of_files = glob.glob(os.path.join(ARCHIVE_DIR, "*.webm"))
                            valid_files = [f for f in list_of_files if os.path.getsize(f) > 1000]
                            if not valid_files:
                                raise Exception("No valid video file found in archive.")
                            latest_video_path = max(valid_files, key=os.path.getctime)
                            
                            myfile = await client.aio.files.upload(file=latest_video_path, config={"mime_type": "video/webm"})
                            
                            while myfile.state.name == "PROCESSING":
                                await asyncio.sleep(2)
                                myfile = await client.aio.files.get(name=myfile.name)
                                
                            if myfile.state.name == "FAILED":
                                raise Exception("Video processing failed in Gemini.")
                                
                            video_prompt = "The session has concluded. I have attached the background video recording of the user during this session. Please output a JSON object with exactly three keys: 'summary' (a comprehensive Markdown summary of the session context), 'insights' (a Markdown bulleted list of interesting visual/behavioral insights derived from analyzing the user's video, body language, and environment), and 'synergy_diff' (a specific Markdown analysis cross-referencing the verbal transcript against the physical body language, pointing out moments where confidence dipped, physical hesitation contradicted verbal assurance, or any behavioral mismatches). Do not use the Option 1 format, just these three keys. DO NOT put the JSON inside a markdown code block, output raw JSON."
                            
                            summary_response = await chat.send_message([myfile, video_prompt])
                            
                            try:
                                raw_text = summary_response.text.strip()
                                if raw_text.startswith("```json"):
                                    raw_text = raw_text[7:-3].strip()
                                elif raw_text.startswith("```"):
                                    raw_text = raw_text[3:-3].strip()
                                parsed_summary = json.loads(raw_text)
                                session_markdown = parsed_summary.get("summary", "Session concluded.")
                                session_insights = parsed_summary.get("insights", "No insights generated.")
                                session_synergy = parsed_summary.get("synergy_diff", "No discrepancies detected.")
                            except Exception as parse_e:
                                print(f"JSON Parse Error: {parse_e}")
                                print(f"Raw Output: {summary_response.text}")
                                session_markdown = "Session concluded, but failed to parse AI JSON summary."
                                session_insights = "No insights generated."
                                session_synergy = "No discrepancies detected."

                            await websocket.send_json({
                                "type": "review_session", 
                                "text": session_markdown,
                                "insights": session_insights,
                                "synergy_diff": session_synergy
                            })
                            
                        except Exception as e:
                            traceback.print_exc()
                            await websocket.send_json({"type": "review_session", "text": f"Error analyzing video: {str(e)}", "insights": ""})
                            
                            
                    elif data.get("type") == "save_dossier":
                        try:
                            session_markdown = data.get("summary", "")
                            timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
                            session_summary_path = os.path.join(ARCHIVE_DIR, f"{timestamp}_Session_Summary.md")
                            with open(session_summary_path, "w") as f:
                                f.write(session_markdown)
                                
                            update_prompt = f"Here is the user's existing Master Dossier:\n{dossier_context}\n\nHere is the summary of their most recent session:\n{session_markdown}\n\nPlease output a fully updated, merged Master Dossier in Markdown format. Keep it concise, categorized (e.g. Current Goals, Emotional State, Action Items), and overwrite outdated information. Do not use JSON."
                            dossier_update_res = await client.aio.models.generate_content(
                                model="gemini-3.6-flash",
                                contents=update_prompt
                            )
                            
                            with open(MASTER_DOSSIER_PATH, "w") as f:
                                f.write(dossier_update_res.text)
                                
                            sync_state_path = os.path.join(ARCHIVE_DIR, "sync_state.json")
                            with open(sync_state_path, "w") as f:
                                json.dump({"last_sync": datetime.datetime.utcnow().isoformat() + "Z"}, f)
                            
                            await websocket.send_json({"type": "summary", "text": "Session saved to Master Dossier."})
                        except Exception as e:
                            traceback.print_exc()
                            await websocket.send_json({"type": "summary", "text": "Failed to save session."})
                            traceback.print_exc()
                            pass
                except Exception as e:
                    pass
                    
            elif "bytes" in message:
                audio_bytes = message["bytes"]
                try:
                    if len(audio_bytes) > 100:
                        
                        # --- FILE ARCHIVAL ENGINE ---
                        now = datetime.datetime.now()
                        year_month_dir = os.path.join(ARCHIVE_DIR, now.strftime("%Y/%m"))
                        os.makedirs(year_month_dir, exist_ok=True)
                        
                        # Generate timestamped filename
                        audio_filename = f"{now.strftime('%Y-%m-%d_%H%M%S')}_session_audio.webm"
                        audio_filepath = os.path.join(year_month_dir, audio_filename)
                        
                        # Save the bytes locally
                        with open(audio_filepath, "wb") as af:
                            af.write(audio_bytes)
                        # ----------------------------

                        part = types.Part.from_bytes(data=audio_bytes, mime_type=current_mime)
                        response = await chat.send_message([part, "The user just spoke. Transcribe and respond."])
                        
                        try:
                            parsed = json.loads(response.text)
                            
                            if parsed.get("tool") == "fetch_rearward_context":
                                await websocket.send_json({"type": "question", "text": "Pulling up your desktop context, emails, and files...", "transcript": parsed.get("transcript", "Catch me up")})
                                context_data = fetch_rearward_context()
                                follow_up = await chat.send_message(f"Here is the rearward context:\n{context_data}\nNow, output Option 1 JSON to summarize this to the user conversationally.")
                                parsed_followup = json.loads(follow_up.text)
                                q_text = parsed_followup.get("question", "I've reviewed your context.")
                                t_text = parsed.get("transcript", "")
                            elif parsed.get("tool") == "fetch_forward_context":
                                await websocket.send_json({"type": "question", "text": "Pulling up your calendar, drafts, and deadlines...", "transcript": parsed.get("transcript", "What's coming up")})
                                context_data = fetch_forward_context()
                                follow_up = await chat.send_message(f"Here is the forward-looking context (Calendar, Drafts, Deadlines):\n{context_data}\nNow, output Option 1 JSON to summarize this to the user conversationally. CRITICAL: At the end of your summary, you MUST explicitly ask the user if there are any big actions, goals, or offline tasks they need to accomplish over the next week or month that are NOT caught in their digital context.")
                                parsed_followup = json.loads(follow_up.text)
                                q_text = parsed_followup.get("question", "I've reviewed your upcoming schedule.")
                                t_text = parsed.get("transcript", "")
                            else:
                                q_text = parsed.get("question", "I didn't generate a question.")
                                t_text = parsed.get("transcript", "")
                        except Exception as parse_e:
                            q_text = response.text if response.text else "Error parsing response."
                            t_text = "Parsing error"
                            
                        await websocket.send_json({"type": "question", "text": q_text, "transcript": t_text})
                    else:
                        await websocket.send_json({"type": "question", "text": "I didn't quite catch that audio. Could you repeat?", "transcript": "(Silence)"})
                except Exception as e:
                    await websocket.send_json({"type": "question", "text": f"[Error during inference]: {str(e)}", "transcript": ""})
                
    except WebSocketDisconnect:
        print("Orchestrator WS Disconnected", flush=True)

@app.websocket("/ws/archive")
async def websocket_archive(websocket: WebSocket):
    await websocket.accept()
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    filepath = os.path.join(ARCHIVE_DIR, f"{timestamp}_Session_Raw.webm")
    try:
        with open(filepath, "wb") as f:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if "bytes" in message:
                    f.write(message["bytes"])
    except (WebSocketDisconnect, RuntimeError):
        pass
