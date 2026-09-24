import io, json, re

rows = json.load(io.open("copy.json", encoding="utf-8"))

AREAS = None
exec(open("build.py").read().split("# group identical text")[0].replace(
     'rows = json.load(io.open("copy.json", encoding="utf-8"))',''))

# --- how many sentences is this? decimals, abbreviations and "e.g." don't count
END = re.compile(r"(?<![0-9])[.!?](?:</?[a-z]+>)?(?:\s|$)")
def sentences(t):
    stripped = re.sub(r"\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}", "X", t)
    stripped = re.sub(r"\be\.g\.|\bi\.e\.|\bvs\.|\betc\.", "", stripped)
    return len(END.findall(stripped))

def self_contained(t):
    bare = re.sub(r"^</?[a-z][^>]*>", "", t).strip()
    bare = re.sub(r"^\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}", "X", bare).strip()
    if not bare: return False
    if not (bare[0].isupper() or bare[0] in "X“\"'"): return False   # a fragment joins on
    tail = re.sub(r"</?[a-z][^>]*>\s*$", "", t).rstrip()
    return bool(tail) and tail[-1] in ".!?”\")"

IDS = {v['text']: k for k, v in json.load(io.open('copy-index.json',encoding='utf-8')).items()}
groups, order = {}, []
PROMPT_FNS = {"exmSystemPrompt","aiCheckPrompt","aiSystemPrompt","aiMatchPrompt"}
AI_AREA = "AI instructions — sent to the plan reader, never shown on screen"
for r in rows:
    t = r["text"]
    if sentences(t) < 2 or not self_contained(t): continue
    if t not in groups:
        area = AI_AREA if r["fn"] in PROMPT_FNS else area_of(r["line"])
        groups[t] = dict(text=t, lines=[], fn=r["fn"], area=area); order.append(t)
    groups[t]["lines"].append(r["line"])

order.sort(key=lambda t: (groups[t]["area"] == AI_AREA, groups[t]["lines"][0]))

out = ["""ELEMENT 26 — THE WRITING, IN WHOLE PARAGRAPHS
============================================
Generated from index.html (app version 11.8).

This is the subset of the app's text worth rewriting: every block that is MORE THAN ONE
SENTENCE and stands on its own. Nothing in here is a fragment stitched together with
other fragments at runtime, so you can rewrite each one freely — split it, join it,
shorten it — without breaking a sentence somewhere else.

  • Edit the text under each [T####] id. Leave the id lines exactly as they are.
  • Keep anything inside ${ } as written — those are values the app fills in
    (${esc(e.name)} the exercise, ${fmtLoad(e.weight)} a weight with your unit).
    Move them around a sentence freely, or delete one you don't want shown.
  • Keep <b> and <br> if you want the emphasis or the line break; delete them if not.
  • Delete entries you don't want to change. Anything missing is left as it is.
  • "same text in N places" means one string used several times — edit it once.

The single words, buttons, labels and joined-up fragments are in the full export
(element26-copy.txt) if you want them later."""]

cur, n = None, 0
for t in order:
    g = groups[t]
    if g["area"] != cur:
        cur = g["area"]
        out.append("\n\n" + "="*74 + "\n" + cur.upper() + "\n" + "="*74)
    n += 1
    where = "line %d" % g["lines"][0]
    if len(g["lines"]) > 1: where += "  ·  same text in %d places" % len(g["lines"])
    # the id must be the one from the full export, so edits from either file land the same
    out.append("\n[%s]  %s\n%s" % (IDS.get(t, "T?"), where, t))

io.open("element26-copy-paragraphs.txt","w",encoding="utf-8").write("\n".join(out) + "\n")
print(n, "entries")
