#!/usr/bin/env python3
"""
Populates the refined, high-leverage 30-question deck based on Claude Fable's critique.
Replaces the bloated 84-question inventory with 30 forced-decision cards tiered for a 4-hour drive.
"""

import os
import shutil
import hashlib
import json

TARGET_DIRS = [
    "/Users/honchpersonal/Documents/MadroneContext/_Inbox/Agent_Hypotheses",
    "/Users/honchpersonal/Documents/Anti-gravity/Personal Context/_Inbox/Agent_Hypotheses"
]

def clean_dirs():
    for d in TARGET_DIRS:
        os.makedirs(d, exist_ok=True)
        for f in os.listdir(d):
            if f.endswith('.md'):
                os.remove(os.path.join(d, f))

# 30 Curated, Sharpened Questions Tiered for 4-Hour Drive
QUESTIONS = [
    # --- TIER 1: BIG ROCKS & STRATEGIC CONSTRAINTS (Cards 01-14) ---
    {
        "id": "tier1-01-kill-list",
        "badge": "STRATEGY: KILL LIST",
        "reservoir": "antigravity",
        "source": "Portfolio Rationalization",
        "priority": 100,
        "question": "Of e-foil, Smart Bowl, Lego Studio, PAX AI, Friend Shares, and Karting upgrades — which two are officially frozen for 12 months as of today?",
        "context": "Forced resource allocation and cognitive de-cluttering across active projects.",
        "tags": ["strategy", "focus", "kill-list"],
        "body": "Identify the two initiatives that will receive zero capital or engineering time for the next 12 months."
    },
    {
        "id": "tier1-02-liquidity-runway",
        "badge": "FINANCE: LIQUIDITY BUFFER",
        "reservoir": "antigravity",
        "source": "Capital Planning",
        "priority": 99,
        "question": "After your current Reno and Moab commitments, what is your liquid cash buffer in months, and what single event would breach it?",
        "context": "Downside protection and liquidity threshold analysis.",
        "tags": ["finance", "liquidity", "runway"],
        "body": "Define the non-negotiable cash reserve and the primary risk scenario."
    },
    {
        "id": "tier1-03-sequencing-conflict",
        "badge": "STRATEGY: SEQUENCING CLASH",
        "reservoir": "antigravity",
        "source": "Master Timeline",
        "priority": 98,
        "question": "Reno purchase, Moab build, and Tahoe winter ops all demand capital and cognitive attention in the same 6-month window. Which one slips, and by how long?",
        "context": "Resolving execution bottlenecks across major property milestones.",
        "tags": ["strategy", "sequencing", "properties"],
        "body": "Establish the priority order and explicitly name what gets deferred."
    },
    {
        "id": "tier1-04-ventana-hold-sell",
        "badge": "VENTANA: HOLD OR SELL",
        "reservoir": "antigravity",
        "source": "Asset Strategy",
        "priority": 97,
        "question": "At current occupancy and ADR, is Ventana a hold, a refinance, or a sale in 24 months? What exact valuation number flips that decision?",
        "context": "Portfolio asset evaluation and capital recycling triggers.",
        "tags": ["ventana", "real-estate", "valuation"],
        "body": "Name the specific financial hurdle or exit multiple."
    },
    {
        "id": "tier1-05-post-acq-obligations",
        "badge": "LEGAL: ACQUISITION CONSTRAINTS",
        "reservoir": "antigravity",
        "source": "Post Acquisition Payout",
        "priority": 96,
        "question": "What earnout, lockup, non-compete, or time-commitment obligations from the acquisition still bind you, and when do they expire?",
        "context": "Invisible legal and contractual boundary conditions governing current work.",
        "tags": ["legal", "acquisition", "governance"],
        "body": "List the expiration dates and legal boundaries that dictate your availability."
    },
    {
        "id": "tier1-06-spg-time-budget",
        "badge": "SPG: TIME ALLOCATION",
        "reservoir": "antigravity",
        "source": "Synergy Pet Group",
        "priority": 95,
        "question": "How many hours per week do you owe Synergy Pet Group, what is the reduction or exit trigger, and what date?",
        "context": "Professional time commitment and transition planning.",
        "tags": ["spg", "time", "transition"],
        "body": "Clarify the target reduction schedule and measurable completion triggers."
    },
    {
        "id": "tier1-07-friend-shares-structure",
        "badge": "FRIEND SHARES: LEGAL SHIELD",
        "reservoir": "antigravity",
        "source": "Friend Shares of Madrone IV",
        "priority": 94,
        "question": "Is Friend Shares structured under a formal securities exemption, who is legal counsel, and what is the first operational detail that could look like an unregistered offering?",
        "context": "Entity compliance and regulatory protection for shared asset ownership.",
        "tags": ["friend-shares", "legal", "compliance"],
        "body": "Verify the formal exemption mechanism and audit partner contributions."
    },
    {
        "id": "tier1-08-key-person-risk",
        "badge": "RESILIENCE: KEY-PERSON RISK",
        "reservoir": "antigravity",
        "source": "Operational Security",
        "priority": 93,
        "question": "If you are completely unreachable for 30 days, what breaks first across Tahoe, Ventana, the headless host, and SPG? Who holds emergency credentials?",
        "context": "Disaster recovery and bus-factor mitigation across all entities.",
        "tags": ["ops", "security", "credentials"],
        "body": "Name the primary points of failure and designated emergency custodians."
    },
    {
        "id": "tier1-09-agent-blast-radius",
        "badge": "AI: AGENT BLAST RADIUS",
        "reservoir": "antigravity",
        "source": "Anti-gravity Architecture",
        "priority": 92,
        "question": "What are the irreversible actions any background agent in your stack is currently permitted to take without human confirmation?",
        "context": "Safety boundaries, financial authority, and system guardrails.",
        "tags": ["ai", "safety", "guardrails"],
        "body": "Audit external API actions, financial calls, and write permissions."
    },
    {
        "id": "tier1-10-hard-deadlines",
        "badge": "OPS: 60-DAY DEADLINES",
        "reservoir": "email",
        "source": "Gmail & Calendar",
        "priority": 91,
        "question": "What decisions or filings have an immovable date in the next 60 days — permit renewals, offer expirations, tax elections, or lease terms?",
        "context": "Critical-path time-sensitive compliance and legal obligations.",
        "tags": ["ops", "deadlines", "calendar"],
        "body": "Surface upcoming hard dates that cannot slip."
    },
    {
        "id": "tier1-11-reno-buy-vs-rent",
        "badge": "RENO: BUY VS RENT",
        "reservoir": "antigravity",
        "source": "Reno House Project",
        "priority": 90,
        "question": "Given your mobility between California, Nevada, and destination properties, why own in Reno at all rather than leasing high-end space?",
        "context": "Challenging the foundational real estate assumption.",
        "tags": ["reno", "real-estate", "assumptions"],
        "body": "Evaluate flexibility and opportunity cost against permanent ownership."
    },
    {
        "id": "tier1-12-post-acq-capital",
        "badge": "CAPITAL: TRANCHE DEPLOYMENT",
        "reservoir": "antigravity",
        "source": "Post Acquisition Payout",
        "priority": 89,
        "question": "What is the size of the next capital tranche, when is it deployable, and which two destinations are you choosing between — Reno purchase, Moab build, or debt paydown?",
        "context": "Forced capital allocation trade-offs.",
        "tags": ["capital", "allocation", "milestones"],
        "body": "State the dollar amount, target date, and preferred allocation split."
    },
    {
        "id": "tier1-13-madrone-5-locations",
        "badge": "MADRONE: 5-YEAR VISION",
        "reservoir": "antigravity",
        "source": "Madrone Future Vision",
        "priority": 88,
        "question": "If Moab is location #3, does its architectural brief change if Madrone is a hospitality brand versus a private club? Which one are you funding this year?",
        "context": "Brand positioning that dictates spatial planning and amenities.",
        "tags": ["madrone", "branding", "moab"],
        "body": "Commit to the business model that governs Moab's master plan."
    },
    {
        "id": "tier1-14-ca-nv-domicile",
        "badge": "LEGAL: CA-NV DOMICILE",
        "reservoir": "antigravity",
        "source": "CA-NV Residency Tracker",
        "priority": 87,
        "question": "What is your target domicile state, what date must the 183-day count be defensible from, and what is the Reno purchase deadline that implies?",
        "context": "Tax residency compliance and calendar constraints.",
        "tags": ["tax", "residency", "compliance"],
        "body": "Define the audit-proof date and required physical days."
    },

    # --- TIER 2: CONCRETE OPERATIONAL DECISIONS (Cards 15-27) ---
    {
        "id": "tier2-15-tahoe-contractor",
        "badge": "TAHOE: CONTRACTOR ULTIMATUM",
        "reservoir": "email",
        "source": "Madrone Tahoe Ops",
        "priority": 80,
        "question": "What is the single unresolved repair item at Madrone Tahoe that you have postponed discussing with the contractor, and what needs to be said?",
        "context": "Property winterization and maintenance accountability.",
        "tags": ["tahoe", "contractor", "maintenance"],
        "body": "Draft the direct feedback or replacement ultimatum."
    },
    {
        "id": "tier2-16-ventana-leases",
        "badge": "VENTANA: LEASE AUDIT",
        "reservoir": "gdocs",
        "source": "La Ventana Lease Agreements",
        "priority": 79,
        "question": "Looking at the Delaney Fiat agreement and Ventana lease legacy, which specific clause is ripe for renegotiation before the upcoming season?",
        "context": "Contractual terms and partnership boundaries.",
        "tags": ["ventana", "leases", "legal"],
        "body": "Target the exact provision creating friction or liability."
    },
    {
        "id": "tier2-17-ventana-ota-transition",
        "badge": "VENTANA: DIRECT BOOKINGS",
        "reservoir": "email",
        "source": "Hostaway & Marketing",
        "priority": 78,
        "question": "What % of Ventana revenue is OTA today, what % is the target in 12 months, and what is the first direct channel or partnership you will build?",
        "context": "Channel diversification and OTA fee reduction.",
        "tags": ["marketing", "bookings", "ota"],
        "body": "Define direct booking targets and outreach channels."
    },
    {
        "id": "tier2-18-tahoe-permits-insurance",
        "badge": "TAHOE: PERMIT & FIRE POLICY",
        "reservoir": "email",
        "source": "Tahoe Municipal Records",
        "priority": 77,
        "question": "Are the Tahoe STR permit and wildfire policy current and adequate for a total-loss scenario? Who verifies by what date?",
        "context": "Risk management and county regulatory compliance.",
        "tags": ["tahoe", "insurance", "permits"],
        "body": "Assign ownership and verification deadlines for coverage."
    },
    {
        "id": "tier2-19-contractor-80-percent",
        "badge": "TEAM: CONTRACTOR PERFORMANCE",
        "reservoir": "email",
        "source": "Vendor Management",
        "priority": 76,
        "question": "Who is an external contractor who delivered 80% of expectations: what explicit instruction gets them to 100%, or do you replace them?",
        "context": "Quality standards and operational execution.",
        "tags": ["contractors", "standards", "team"],
        "body": "Decide whether to coach, re-scope, or substitute."
    },
    {
        "id": "tier2-20-calendar-refusal",
        "badge": "ENERGY: CALENDAR DEFENSE",
        "reservoir": "email",
        "source": "Calendar Review",
        "priority": 75,
        "question": "Looking at meeting requests and recurring obligations over the next month, what commitment should you decline before this drive ends?",
        "context": "Proactive protection of deep-focus engineering time.",
        "tags": ["calendar", "focus", "boundaries"],
        "body": "Name the specific meeting or person to decline."
    },
    {
        "id": "tier2-21-agent-wire-limits",
        "badge": "BANKING: WIRE SAFEGUARDS",
        "reservoir": "antigravity",
        "source": "Mercury Wires Integration",
        "priority": 74,
        "question": "What is the exact dollar threshold above which an automated Mercury wire or ACH requires manual biometric confirmation, and what is the kill switch?",
        "context": "Financial automation safety and access controls.",
        "tags": ["banking", "mercury", "security"],
        "body": "Establish hard programmatic limits for autonomous payment drafting."
    },
    {
        "id": "tier2-22-headless-host-uptime",
        "badge": "INFRA: HEADLESS SERVER",
        "reservoir": "antigravity",
        "source": "Mac Mini Headless Setup",
        "priority": 73,
        "question": "What failure mode on the headless Mac Mini host would completely blindside you while traveling, and what watchdog service should monitor it?",
        "context": "Remote infrastructure resilience over Tailscale.",
        "tags": ["infrastructure", "headless", "uptime"],
        "body": "Identify power, network, or process watchdog requirements."
    },
    {
        "id": "tier2-23-luxury-retreat-gap",
        "badge": "BRAND: WANDER/INSPIRATO GAP",
        "reservoir": "gdocs",
        "source": "Luxury Rental Market Research",
        "priority": 72,
        "question": "What will Madrone properties deliver that Wander or Inspirato structurally cannot, and how does that show up as an explicit line item guests pay for?",
        "context": "Competitive differentiation in high-end experiential hospitality.",
        "tags": ["hospitality", "brand", "pricing"],
        "body": "Focus on bespoke tactile immersion vs. corporate cookie-cutter stays."
    },
    {
        "id": "tier2-24-ventana-house-rules",
        "badge": "VENTANA: HOUSE POLICIES",
        "reservoir": "gdocs",
        "source": "Madrone Ventana Reservation Rules",
        "priority": 71,
        "question": "What house policy or booking rule at Ventana was instituted because of a painful past lesson, and does it still serve its intended purpose?",
        "context": "Guest experience policy audit and friction reduction.",
        "tags": ["ventana", "guest-ops", "policies"],
        "body": "Review pet, noise, or booking rules that create friction."
    },
    {
        "id": "tier2-25-partner-signing-metric",
        "badge": "GOVERNANCE: PARTNER AUTONOMY",
        "reservoir": "gdocs",
        "source": "Governance & Team Charter",
        "priority": 70,
        "question": "Name an operational partner, name the performance metric, and name the exact number that unlocks independent signing authority for them.",
        "context": "Decentralized management and delegation thresholds.",
        "tags": ["governance", "delegation", "partners"],
        "body": "Create clear objective criteria for operational handoff."
    },
    {
        "id": "tier2-26-tesla-diagnostic-escalation",
        "badge": "TESLA: DIAGNOSTIC ESCALATION",
        "reservoir": "antigravity",
        "source": "Tesla Fix Project",
        "priority": 69,
        "question": "What specific engineering diagnosis remains unresolved with Tesla service, and what is your escalation threshold before taking external action?",
        "context": "Hardware repair accountability and warranty enforcement.",
        "tags": ["tesla", "hardware", "diagnostics"],
        "body": "Summarize the technical defect and next service demand."
    },
    {
        "id": "tier2-27-travel-mobile-kit",
        "badge": "OPS: MOBILE RIG RESILIENCE",
        "reservoir": "email",
        "source": "Travel Rig Logistics",
        "priority": 68,
        "question": "When traveling between properties, what piece of your mobile context setup has broken down most often, and how will you bulletproof it today?",
        "context": "Travel hardware ergonomics and continuous sync health.",
        "tags": ["hardware", "travel", "productivity"],
        "body": "Isolate cables, battery, network, or sync friction points."
    },

    # --- TIER 3: CREATIVE HORIZONS & CLOSING COMMITMENT (Cards 28-30) ---
    {
        "id": "tier3-28-pax-ai-deliverable",
        "badge": "PAX AI: SHIP COMMITMENT",
        "reservoir": "antigravity",
        "source": "Pax AI Education",
        "priority": 60,
        "question": "What is the single concrete artifact — a lesson, an interactive app, or a physical game — you will ship for Pax AI this quarter, and what does success look like?",
        "context": "Educational curriculum milestone and deliverable clarity.",
        "tags": ["pax-ai", "education", "deliverable"],
        "body": "Define the simplest functional deliverable and test criteria."
    },
    {
        "id": "tier3-29-local-nvme-workload",
        "badge": "LAB: LOCAL NVME WORKLOAD",
        "reservoir": "antigravity",
        "source": "Headless Hardware Lab",
        "priority": 59,
        "question": "With local high-throughput NVMe storage online, what large dataset, model, or archive should you host locally rather than paying cloud egress fees?",
        "context": "Local compute utilization and infrastructure efficiency.",
        "tags": ["hardware", "storage", "lab"],
        "body": "Select the primary local data store or local embedding pipeline."
    },
    {
        "id": "tier3-30-closing-commitment",
        "badge": "DRIVE: CLOSING COMMITMENT",
        "reservoir": "antigravity",
        "source": "Drive Conclusion Protocol",
        "priority": 50,
        "question": "What decision did you avoid over the last 4 hours, and what is the smallest concrete commitment you will make on it before stepping out of the car?",
        "context": "Ensuring the driving reflection converts into immediate action.",
        "tags": ["drive", "commitment", "action"],
        "body": "State the non-avoidance commitment and the immediate first step."
    }
]

def main():
    clean_dirs()
    print(f"Generating {len(QUESTIONS)} refined, tiered question cards...")
    for idx, q in enumerate(QUESTIONS, 1):
        slug = q['id'].replace('tier1-', '').replace('tier2-', '').replace('tier3-', '')
        filename = f"{idx:02d}_{slug}.md"
        content = f"""---
id: "{q['id']}"
badge: "{q['badge']}"
reservoir: "{q['reservoir']}"
source: "{q['source']}"
question: "{q['question'].replace('\"', '\\\"')}"
context: "{q['context'].replace('\"', '\\\"')}"
priority: {q['priority']}
tags: {json.dumps(q['tags'])}
---

### Spoken Prompt
{q['question']}

### Strategic Context
- **Tier & Focus**: {q['badge']}
- **Source Context**: {q['source']} ({q['reservoir'].upper()})

### Forced Decision Angles
{q['body']}
"""
        for d in TARGET_DIRS:
            filepath = os.path.join(d, filename)
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)

    print(f"Successfully populated {len(QUESTIONS)} tiered cards in:")
    for d in TARGET_DIRS:
        print(f"  - {d}")

if __name__ == '__main__':
    main()
