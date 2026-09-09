import json
import keyring
from datetime import datetime
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from .base import ContextPlugin

class GoogleWorkspacePlugin(ContextPlugin):
    @property
    def name(self) -> str:
        return "Google Workspace"

    def _get_creds(self, suffix: str):
        try:
            raw = keyring.get_password("AntiGravity", f"google-token-{suffix}")
            if raw:
                token_data = json.loads(raw)
                return Credentials.from_authorized_user_info(token_data)
            return None
        except:
            return None

    def fetch_rearward_context(self, since_timestamp: str) -> str:
        accounts = [
            ("Personal (john.honchariw@gmail.com)", "Personal"),
            ("Collective (honch@madrone-collective.com)", "Collective"),
            ("IV (honch@madrone-iv.com)", "IV")
        ]
        
        try:
            dt = datetime.fromisoformat(since_timestamp.replace("Z", "+00:00"))
            unix_time = int(dt.timestamp())
        except:
            unix_time = int(datetime.utcnow().timestamp()) - 86400
            
        query = f"after:{unix_time}"
        
        all_results = []
        
        for account_name, suffix in accounts:
            creds = self._get_creds(suffix)
            if not creds:
                all_results.append(f"[{account_name}] No credentials found.")
                continue
                
            try:
                gmail_service = build('gmail', 'v1', credentials=creds)
                
                # Fetch recent Inbox emails
                inbox_query = f"in:inbox after:{unix_time}"
                inbox_results = gmail_service.users().messages().list(userId='me', q=inbox_query, maxResults=10).execute()
                inbox_msgs = inbox_results.get('messages', [])
                
                # Fetch recent Sent emails
                sent_query = f"in:sent after:{unix_time}"
                sent_results = gmail_service.users().messages().list(userId='me', q=sent_query, maxResults=5).execute()
                sent_msgs = sent_results.get('messages', [])
                
                all_msgs = inbox_msgs + sent_msgs
                
                if not all_msgs:
                    all_results.append(f"[{account_name}] No new emails (inbox or sent).")
                else:
                    for msg in all_msgs:
                        msg_data = gmail_service.users().messages().get(userId='me', id=msg['id'], format='metadata').execute()
                        headers = msg_data.get('payload', {}).get('headers', [])
                        subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
                        sender = next((h['value'] for h in headers if h['name'] == 'From'), 'Unknown Sender')
                        snippet = msg_data.get('snippet', '')
                        
                        all_results.append(f"[{account_name}] Email (From: {sender}): {subject} - {snippet}")
            except Exception as e:
                all_results.append(f"[{account_name}] Gmail Error: {str(e)}")
                
            try:
                drive_service = build('drive', 'v3', credentials=creds)
                drive_query = f"modifiedTime > '{since_timestamp}'"
                drive_results = drive_service.files().list(q=drive_query, pageSize=5, fields="files(id, name, modifiedTime)").execute()
                files = drive_results.get('files', [])
                
                if not files:
                    all_results.append(f"[{account_name}] No newly modified documents.")
                else:
                    for f in files:
                        all_results.append(f"[{account_name}] Modified Document: {f['name']} (at {f['modifiedTime']})")
            except Exception as e:
                all_results.append(f"[{account_name}] Drive Error: {str(e)}")
                
        return "\n".join(all_results)

    def fetch_forward_context(self) -> str:
        from datetime import timedelta
        accounts = [
            ("Personal (john.honchariw@gmail.com)", "Personal"),
            ("Collective (honch@madrone-collective.com)", "Collective"),
            ("IV (honch@madrone-iv.com)", "IV")
        ]
        
        all_results = []
        now = datetime.utcnow()
        in_7_days = now + timedelta(days=7)
        now_iso = now.isoformat() + 'Z'
        in_7_days_iso = in_7_days.isoformat() + 'Z'
        
        for account_name, suffix in accounts:
            creds = self._get_creds(suffix)
            if not creds:
                all_results.append(f"[{account_name}] No credentials found.")
                continue
                
            # 1. Calendar
            try:
                calendar_service = build('calendar', 'v3', credentials=creds)
                events_result = calendar_service.events().list(
                    calendarId='primary', timeMin=now_iso, timeMax=in_7_days_iso,
                    maxResults=10, singleEvents=True, orderBy='startTime'
                ).execute()
                events = events_result.get('items', [])
                
                if not events:
                    all_results.append(f"[{account_name}] Calendar: No upcoming events in the next 7 days.")
                else:
                    for event in events:
                        start = event['start'].get('dateTime', event['start'].get('date'))
                        summary = event.get('summary', 'Untitled')
                        all_results.append(f"[{account_name}] Upcoming Event: {summary} (at {start})")
            except Exception as e:
                all_results.append(f"[{account_name}] Calendar Error: {str(e)}")
                
            # 2. Gmail
            try:
                gmail_service = build('gmail', 'v1', credentials=creds)
                
                # Helper to fetch emails
                def fetch_emails(query, label):
                    results = gmail_service.users().messages().list(userId='me', q=query, maxResults=5).execute()
                    msgs = results.get('messages', [])
                    for msg in msgs:
                        msg_data = gmail_service.users().messages().get(userId='me', id=msg['id'], format='metadata').execute()
                        headers = msg_data.get('payload', {}).get('headers', [])
                        subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
                        all_results.append(f"[{account_name}] {label}: {subject}")
                
                fetch_emails("is:draft", "Draft Email")
                fetch_emails("is:starred", "Starred Email")
                fetch_emails("in:inbox (deadline OR due OR \"action required\" OR invoice) newer_than:7d", "Received Deadline")
                fetch_emails("in:sent (deadline OR due OR timeline OR \"action required\") newer_than:7d", "Sent Deadline")
                
            except Exception as e:
                all_results.append(f"[{account_name}] Gmail Forward Context Error: {str(e)}")
                
        return "\n".join(all_results)
