import io, json, re
rows = json.load(io.open("copy.json", encoding="utf-8"))

AREAS = [
 (0,      "App shell and offline page"),
 (3921,   "Training days, split and rest credits"),
 (4497,   "Glossary and in-app explanations"),
 (5349,   "Set techniques"),
 (5460,   "Exercise coaching cues"),
 (6161,   "Machine taken / swap a movement"),
 (6438,   "Account, sign-in and sync"),
 (7583,   "Exercise notes and flags"),
 (8006,   "Alternating and choice slots"),
 (8708,   "Programming suggestions and per-set RPE"),
 (9007,   "Muscle detection"),
 (9399,   "Experience level and volume landmarks"),
 (9982,   "Onboarding"),
 (10406,  "Reporting a problem"),
 (10457,  "Reminders and notifications"),
 (10551,  "Waking up, weight and sleep"),
 (11096,  "Syncing"),
 (11236,  "The first-run tour"),
 (11905,  "Importing a plan (reader and questions)"),
 (13144,  "The importer, screen by screen"),
 (14279,  "Settings"),
 (14532,  "The cycle strip"),
 (14902,  "Daily check-in and sleep entry"),
 (15188,  "Today tab and workout logging"),
 (15785,  "Coaching hints and RPE targets"),
 (16877,  "History and attribution"),
 (17162,  "Body tab"),
 (19735,  "Gyms and location"),
 (20280,  "Plan change log"),
 (20373,  "The day editor, switching and adding"),
 (21346,  "Workout quality score"),
 (22249,  "Progressive overload and stalls"),
 (23537,  "Bars, plates and rounding"),
 (24088,  "Technique badges and supersets"),
 (25130,  "The printed plan document"),
 (25921,  "The daily line and everything after"),
]
PROMPT_FNS = {"exmSystemPrompt","aiCheckPrompt","aiSystemPrompt","aiMatchPrompt"}
def area_of(ln):
    lab = AREAS[0][1]
    for start, name in AREAS:
        if ln >= start: lab = name
        else: break
    return lab

# group identical text
groups = {}
order = []
for r in rows:
    t = r["text"]
    if t not in groups:
        area = ("AI instructions — sent to the plan reader, never shown on screen"
                if r["fn"] in PROMPT_FNS else area_of(r["line"]))
        groups[t] = dict(text=t, lines=[], fn=r["fn"], area=area)
        order.append(t)
    groups[t]["lines"].append(r["line"])

AI_AREA = "AI instructions — sent to the plan reader, never shown on screen"
order.sort(key=lambda t: (groups[t]["area"] == AI_AREA, groups[t]["lines"][0]))

out = []
out.append("""ELEMENT 26 — EVERY PIECE OF TEXT THE APP SHOWS
=============================================
Generated from index.html (app version 11.8).

HOW TO EDIT THIS FILE
  • Each entry is an ID line starting with [T####] followed by the text on the next line(s).
  • Change the TEXT ONLY. Leave the [T####] line exactly as it is — that is how the edit
    gets put back in the right place.
  • Keep anything inside ${ } exactly as written. Those are placeholders the app fills in:
      ${esc(e.name)}            the exercise's name
      ${sug.sets}               a number the app works out
      ${fmtLoad(e.weight)}      a weight with your unit on it
    You can MOVE a placeholder within the sentence, or delete one if you don't want that
    value shown — just don't rename or invent them.
  • Keep any HTML tags (<b>, <br>, <span …>) if you want the same emphasis; delete them if
    you don't. Don't add tags that weren't there.
  • If you want an entry left alone, just leave it as it is.
  • A few entries are sentence FRAGMENTS — the app joins them at runtime ("was ", the
    reason, ", target"). They read oddly on their own; keep the leading/trailing spaces
    and commas where they are and they will join up the same way.
  • Entries marked "same text in N places" are one string used several times — editing it
    changes all of them.
  • Delete whole entries you don't care about; anything missing is treated as unchanged.

WHAT IS NOT IN HERE
  • Exercise names (about 450 of them) and muscle names, which are labels rather than
    writing. Ask and I'll export those too.
  • The AI instructions ARE included, in the last section. They are not shown on screen —
    they are what the plan reader is told to do — so edit those only if you mean to change
    how a plan is read.
""")

cur = None
n = 0
for t in order:
    g = groups[t]
    if g["area"] != cur:
        cur = g["area"]
        out.append("\n\n" + "="*74 + "\n" + cur.upper() + "\n" + "="*74)
    n += 1
    tag = "T%04d" % n
    where = "line %d" % g["lines"][0]
    if len(g["lines"]) > 1: where += "  ·  same text in %d places" % len(g["lines"])
    if g["fn"]: where += "  ·  " + g["fn"] + "()"
    out.append("\n[%s]  %s\n%s" % (tag, where, g["text"]))
    groups[t]["id"] = tag

io.open("element26-copy.txt","w",encoding="utf-8").write("\n".join(out) + "\n")
json.dump({groups[t]["id"]: {"text": t, "lines": groups[t]["lines"]} for t in order},
          io.open("copy-index.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
print(n, "entries")
