# Pull every user-facing string out of index.html.
# Two passes: (1) JS string literals, (2) text inside HTML template literals.
import io, re, json, sys

SRC = "/home/user/ShowcaseE26/index.html"
src = io.open(SRC, encoding="utf-8").read()
lines = src.split("\n")

# --- where does each <script> block live, and where do CSS/<style> blocks live
def spans(tag):
    out=[]
    for m in re.finditer(r"<"+tag+r"[^>]*>", src):
        e = src.find("</"+tag+">", m.end())
        out.append((m.end(), e if e>0 else len(src)))
    return out
js_spans = spans("script")
css_spans = spans("style")

def in_spans(i, sp): return any(a <= i < b for a,b in sp)

def line_of(i): return src.count("\n", 0, i) + 1

# --- section headings: the big banner comments, used to name an area
sections = []
for m in re.finditer(r"/\*[=\s]*\n?\s*([A-Z][A-Z0-9 ,'\"/&\-\(\)\.]{6,})\n", src):
    sections.append((m.start(), " ".join(m.group(1).split())))
# also function names
funcs = []
for m in re.finditer(r"\nfunction\s+([A-Za-z0-9_$]+)\s*\(", src):
    funcs.append((m.start(), m.group(1)))
def nearest(lst, i, default=""):
    best = default
    for pos, name in lst:
        if pos <= i: best = name
        else: break
    return best

# ---------- tokenizer: walk the JS blocks, collecting string literals ----------
literals = []   # (start_index, quote, raw_inner)
for a, b in js_spans:
    i = a
    n = b
    while i < n:
        c = src[i]
        # comments
        if c == "/" and i+1 < n and src[i+1] == "/":
            j = src.find("\n", i);  i = n if j < 0 else j+1;  continue
        if c == "/" and i+1 < n and src[i+1] == "*":
            j = src.find("*/", i);  i = n if j < 0 else j+2;  continue
        if c in "'\"":
            j = i+1
            while j < n:
                if src[j] == "\\": j += 2; continue
                if src[j] == c: break
                if src[j] == "\n": break          # unterminated: bail
                j += 1
            if j < n and src[j] == c:
                literals.append((i, c, src[i+1:j]))
                i = j+1; continue
            i += 1; continue
        if c == "`":
            depth = 0
            j = i+1
            while j < n:
                if src[j] == "\\": j += 2; continue
                if src[j] == "`" and depth == 0: break
                if src[j] == "$" and j+1 < n and src[j+1] == "{":
                    d = 1; k = j+2
                    while k < n and d:
                        if src[k] == "{": d += 1
                        elif src[k] == "}": d -= 1
                        elif src[k] in "'\"`":   # nested string inside ${}
                            q = src[k]; k += 1
                            while k < n:
                                if src[k] == "\\": k += 2; continue
                                if src[k] == q: break
                                k += 1
                        k += 1
                    j = k; continue
                j += 1
            if j < n:
                literals.append((i, "`", src[i+1:j]))
                i = j+1; continue
            i += 1; continue
        i += 1

# ---------- filters ----------
CODE_RE = [
    re.compile(r"^[a-z][a-zA-Z0-9_]*$"),                 # identifiers / keys
    re.compile(r"^[A-Z][A-Z0-9_]*$"),                    # CONSTS
    re.compile(r"^[a-z0-9_\-]+$"),                       # css class / data key
    re.compile(r"^[#\.\[]"),                             # selectors
    re.compile(r"^https?://|^data:|^blob:|^/[a-z]"),     # urls / paths
    re.compile(r"^\S+\.(js|json|html|png|webmanifest|css|svg)$", re.I),
    re.compile(r"^[\d\s\.,:%\-\+/×·]+$"),                # pure numbers/punct
    re.compile(r"^(px|em|rem|vh|vw|%)$"),
]
CSSISH = re.compile(r"(?:^|;)\s*[a-z\-]+\s*:\s*[^;]+;?\s*$")
HAS_WORD = re.compile(r"[A-Za-z]{2,}")
SVGISH = re.compile(r"^[MmLlHhVvCcSsQqTtAaZz0-9\.\-,\s]+$")

CODEY = re.compile(r"=>|\bfunction\b|\breturn\b|\bconst \b|\blet \b|\bvar \b|\.push\(|\.length|document\.|querySelector|classList|\bnull\b|\bundefined\b|\)\{|\}\)|;\s*$|\|\||&&")
def looks_code(t):
    s = t.strip()
    if s.startswith("var(--"): return True
    if "</svg>" in s or s.startswith('"/>') or s.startswith("/>"): return True
    if "viewBox=" in s or "charset" in s or s in ("use strict",) or re.match(r"^gemini-[\d.]", s): return True
    if s.startswith("<path") or 'd="M' in s or s.startswith("<circle") or s.startswith("<svg"): return True
    if CODEY.search(s): return True
    if s.count("${") != s.count("}"): return True
    if s.endswith("(") or s.startswith(")") or s.startswith("="): return True
    if re.match(r"^[a-z\-]+\s*:\s*[\w\s\.%#\-,()]+;?$", s): return True      # inline css
    if "showModal(" in s or s.startswith("`") or s.endswith("`"): return True
    if re.match(r"^\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}$", s): return True          # a lone expression
    if s.startswith("e26.") or s.startswith("ironlog"): return True
    if not s: return True
    if not HAS_WORD.search(s): return True
    if len(s) < 2: return True
    for r in CODE_RE:
        if r.match(s): return True
    if CSSISH.match(s) and " " not in s.strip(";"): return True
    if SVGISH.match(s) and len(s) > 8: return True
    if s.count(":") and s.count(";") >= 2 and "  " not in s: return True   # inline css
    if re.match(r"^[a-z]+([A-Z][a-z]+)+$", s): return True                 # camelCase key
    return False

# ---------- pull display text out of a template literal ----------
INLINE = {"b","i","em","strong","span","br","small","u","a","sup","sub","code"}
TAGRE = re.compile(r"</?([A-Za-z][A-Za-z0-9]*)\b[^>]*>|<[^>]*>", re.S)
ATTR_TEXT = re.compile(r'\b(placeholder|aria-label|title|alt)\s*=\s*"([^"]*)"', re.I)

def texts_from_template(t):
    """Split a template on STRUCTURAL tags only, so a sentence carrying <b> stays whole."""
    out = []
    for m in ATTR_TEXT.finditer(t):
        v = m.group(2).strip()
        if v and not looks_code(v): out.append(("attr:"+m.group(1).lower(), v))
    chunks, last = [], 0
    for m in TAGRE.finditer(t):
        name = (m.group(1) or "").lower()
        if name in INLINE:      # keep it inside the sentence
            continue
        chunks.append(t[last:m.start()])
        last = m.end()
    chunks.append(t[last:])
    for pt in chunks:
        v = " ".join(pt.split())
        if not v: continue
        bare = re.sub(r"\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}", "", v)
        bare = re.sub(r"</?[A-Za-z][^>]*>", "", bare).strip()
        if not bare or looks_code(bare) or not HAS_WORD.search(bare): continue
        out.append(("text", v))
    return out

# ---------- ranges that are data, not copy ----------
def const_range(name):
    m = re.search(r"\nconst "+name+r"\s*=", src)
    if not m: return (0,0)
    j = src.find("\n};", m.end())
    if j < 0: j = src.find("\n];", m.end())
    return (m.start(), j if j>0 else m.end())
CATALOG = const_range("EX_CATALOG")
LIB1 = const_range("EX_LIBRARY"); LIB2 = const_range("EX_LIBRARY_EXTRA")

KEY_BEFORE = re.compile(r"([A-Za-z_$][\w$]*)\s*:\s*$")
def key_of(pos):
    back = src[max(0,pos-40):pos]
    m = KEY_BEFORE.search(back)
    return m.group(1) if m else ""

DROP_KEYS = {"name","gear","slot","id","k","v","key","cls","icon","color","tag","g","href","src"}

rows = []
seen = set()
for pos, q, raw in literals:
    ln = line_of(pos)
    if CATALOG[0] <= pos <= CATALOG[1]: continue
    k = key_of(pos)
    inlib = (LIB1[0] <= pos <= LIB1[1]) or (LIB2[0] <= pos <= LIB2[1])
    if inlib and k != "cue": continue
    if k in DROP_KEYS and q != "`": continue
    sec = nearest(sections, pos)
    fn  = nearest(funcs, pos)
    if q == "`":
        if "<" in raw and ">" in raw:
            for kind, v in texts_from_template(raw):
                key = (v, ln)
                if key in seen: continue
                seen.add(key)
                rows.append(dict(line=ln, kind=kind, text=v, fn=fn, sec=sec, key=k))
        else:
            v = " ".join(raw.split())
            if v and not looks_code(re.sub(r"\$\{[^{}]*\}", "", v)):
                key = (v, ln)
                if key not in seen:
                    seen.add(key); rows.append(dict(line=ln, kind="tpl", text=v, fn=fn, sec=sec, key=k))
    else:
        v = raw.replace("\\n", " ").replace('\\"','"').replace("\\'","'")
        v = " ".join(v.split())
        if looks_code(v): continue
        key = (v, ln)
        if key in seen: continue
        seen.add(key)
        rows.append(dict(line=ln, kind="str", text=v, fn=fn, sec=sec, key=k))

rows.sort(key=lambda r: r["line"])
json.dump(rows, io.open(sys.argv[1] if len(sys.argv)>1 else "/tmp/copy.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(rows), "strings")
