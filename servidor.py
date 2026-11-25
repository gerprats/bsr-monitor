#!/usr/bin/env python3
"""Monitor de BSR de Amazon. Solo librería estándar + curl del sistema.

Uso:  python3 servidor.py [--puerto 8770] [--db ruta.sqlite] [--no-abrir] [--sin-programador]
"""
import argparse
import html
import json
import random
import re
import sqlite3
import subprocess
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
WEB = RAIZ / "web"

# código -> (dominio, nombre, bandera)
MERCADOS = {
    "US": ("amazon.com", "Estados Unidos", "🇺🇸"),
    "UK": ("amazon.co.uk", "Reino Unido", "🇬🇧"),
    "DE": ("amazon.de", "Alemania", "🇩🇪"),
    "FR": ("amazon.fr", "Francia", "🇫🇷"),
    "ES": ("amazon.es", "España", "🇪🇸"),
    "IT": ("amazon.it", "Italia", "🇮🇹"),
    "NL": ("amazon.nl", "Países Bajos", "🇳🇱"),
    "CA": ("amazon.ca", "Canadá", "🇨🇦"),
    "MX": ("amazon.com.mx", "México", "🇲🇽"),
    "BR": ("amazon.com.br", "Brasil", "🇧🇷"),
    "AU": ("amazon.com.au", "Australia", "🇦🇺"),
    "JP": ("amazon.co.jp", "Japón", "🇯🇵"),
    "IN": ("amazon.in", "India", "🇮🇳"),
    "PL": ("amazon.pl", "Polonia", "🇵🇱"),
    "SE": ("amazon.se", "Suecia", "🇸🇪"),
}
DOMINIO_A_MERCADO = {v[0]: k for k, v in MERCADOS.items()}
# India fuera por defecto: los ASIN de tapa blanda de KDP no existen allí
MERCADOS_DEFECTO = ["US", "UK", "DE", "FR", "ES", "IT", "NL", "CA", "MX", "BR", "AU", "JP"]

ETIQUETAS_BSR = [
    "Best Sellers Rank",
    "Clasificación en los más vendidos de Amazon",
    "Amazon Bestseller-Rang",
    "Amazon Bestseller:",
    "Classement des meilleures ventes d'Amazon",
    "Posizione nella classifica Bestseller di Amazon",
    "Plaats in bestsellerlijst",
    "Ranking dos mais vendidos",
    "Amazon 売れ筋ランキング",
    "Rangordning för bästsäljare",
    "Ranking najlepiej sprzedających się",
]
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")

DB_RUTA = RAIZ / "bsr.sqlite"
_db_lock = threading.Lock()
_ciclo_lock = threading.Lock()
progreso = {"activo": False, "hechos": 0, "total": 0, "actual": "", "inicio": 0, "aviso": ""}


# ---------------------------------------------------------------- base de datos
def con():
    c = sqlite3.connect(DB_RUTA, timeout=30)
    c.row_factory = sqlite3.Row
    return c


def iniciar_db():
    with con() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS libros(
            asin TEXT PRIMARY KEY, titulo TEXT DEFAULT '', marca TEXT DEFAULT '',
            portada TEXT DEFAULT '', mercados TEXT DEFAULT '', activo INTEGER DEFAULT 1,
            creado INTEGER);
        CREATE TABLE IF NOT EXISTS lecturas(
            id INTEGER PRIMARY KEY, asin TEXT, mercado TEXT, ts INTEGER,
            bsr INTEGER, estado TEXT, categorias TEXT, valoracion REAL, resenas INTEGER);
        CREATE INDEX IF NOT EXISTS ix_lect ON lecturas(asin, mercado, ts);
        CREATE INDEX IF NOT EXISTS ix_lect_ts ON lecturas(ts);
        CREATE TABLE IF NOT EXISTS config(clave TEXT PRIMARY KEY, valor TEXT);
        """)
        if "serie" not in [f[1] for f in c.execute("PRAGMA table_info(libros)")]:
            c.execute("ALTER TABLE libros ADD COLUMN serie TEXT DEFAULT ''")


def cfg(clave, defecto=None):
    with con() as c:
        f = c.execute("SELECT valor FROM config WHERE clave=?", (clave,)).fetchone()
    return json.loads(f["valor"]) if f else defecto


def cfg_set(clave, valor):
    with _db_lock, con() as c:
        c.execute("INSERT INTO config(clave,valor) VALUES(?,?) "
                  "ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor", (clave, json.dumps(valor)))


# ---------------------------------------------------------------- lectura de Amazon
def url_producto(asin, mercado):
    return f"https://www.{MERCADOS[mercado][0]}/dp/{asin}"


def _entero(txt):
    d = re.sub(r"\D", "", txt)
    return int(d) if d else None


def analizar(pagina):
    """Devuelve dict con bsr, categorias, titulo, portada, valoracion, resenas."""
    r = {"bsr": None, "categorias": [], "titulo": "", "portada": "", "valoracion": None, "resenas": None}
    m = re.search(r'id="productTitle"[^>]*>([^<]+)', pagina)
    if m:
        r["titulo"] = html.unescape(m.group(1)).strip()
    m = re.search(r'id="(?:landingImage|imgBlkFront|ebooksImgBlkFront)"[^>]*?'
                  r'(https://m\.media-amazon\.com/images/I/[A-Za-z0-9+%-]+)\.', pagina, re.S)
    if m:
        r["portada"] = m.group(1) + "._SY300_.jpg"
    m = re.search(r'id="acrPopover"[^>]*title="([\d.,]+)', pagina)
    if m:
        try:
            r["valoracion"] = float(m.group(1).replace(",", "."))
        except ValueError:
            pass
    m = re.search(r'id="acrCustomerReviewText"[^>]*>([^<]+)', pagina)
    if m:
        r["resenas"] = _entero(m.group(1))

    for etiqueta in ETIQUETAS_BSR:
        for variante in (etiqueta, html.escape(etiqueta, quote=True), etiqueta.replace("'", "&#39;")):
            i = pagina.find(variante)
            if i >= 0:
                break
        else:
            continue
        trozo = pagina[i + len(variante): i + len(variante) + 4000]
        txt = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", trozo, flags=re.S)
        txt = html.unescape(re.sub(r"<[^>]+>", " ", txt))
        txt = re.sub(r"\s+", " ", txt)
        m = re.search(r"\d{1,3}(?:[.,   ]\d{3})+|\d+", txt[:160])
        if not m:
            continue
        r["bsr"] = _entero(m.group(0))
        # subcategorías (formato inglés, que es el que pedimos con Accept-Language)
        corte = re.split(r"Customer [Rr]eviews|Avalia|Opiniones|Kundenrezension|var |P\.when", txt)[0]
        corte = re.sub(r"\([^()]*Top 100[^()]*\)", " ", corte)
        pares = re.findall(r"(?:#|Nº|nº|Nr\.|n\.)?\s*(\d[\d.,]*) (?:in|em|en) (.+?)(?=\s+(?:#|Nº|nº|Nr\.|n\.)?\s*\d[\d.,]* (?:in|em|en) |\s*$)", corte)
        r["categorias"] = [[_entero(n), cat.strip()[:80]] for n, cat in pares[1:5] if _entero(n) and cat.strip()]
        break
    return r


def descargar(asin, mercado):
    """-> (estado, datos). estado: ok | sin_ranking | no_disponible | bloqueado | error"""
    try:
        p = subprocess.run(
            ["curl", "-s", "-L", "--compressed", "--max-time", "40", "-w", "\n%{http_code}",
             "-H", f"User-Agent: {UA}",
             "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
             "-H", "Accept-Language: en-US,en;q=0.9",
             url_producto(asin, mercado)],
            capture_output=True, timeout=60)
    except Exception:
        return "error", {}
    cuerpo = p.stdout.decode("utf-8", errors="ignore")
    cuerpo, _, codigo = cuerpo.rpartition("\n")
    if codigo == "404":
        return "no_disponible", {}
    if codigo in ("503", "429", "403") or "api-services-support@amazon.com" in cuerpo \
            or (len(cuerpo) < 30000 and "captcha" in cuerpo.lower()):
        return "bloqueado", {}
    if codigo != "200":
        return "error", {}
    d = analizar(cuerpo)
    if d["bsr"]:
        return "ok", d
    if d["titulo"]:
        return "sin_ranking", d
    return "error", d


def guardar_lectura(asin, mercado, estado, d):
    ts = int(time.time())
    with _db_lock, con() as c:
        c.execute("INSERT INTO lecturas(asin,mercado,ts,bsr,estado,categorias,valoracion,resenas) "
                  "VALUES(?,?,?,?,?,?,?,?)",
                  (asin, mercado, ts, d.get("bsr"), estado, json.dumps(d.get("categorias") or [], ensure_ascii=False),
                   d.get("valoracion"), d.get("resenas")))
        if d.get("titulo"):
            c.execute("UPDATE libros SET titulo=? WHERE asin=? AND titulo=''", (d["titulo"], asin))
        if d.get("portada"):
            c.execute("UPDATE libros SET portada=? WHERE asin=? AND portada=''", (d["portada"], asin))


def ciclo(asins=None, programado=False):
    """Lee todos los pares libro×país. Devuelve False si ya había un ciclo en marcha."""
    if not _ciclo_lock.acquire(blocking=False):
        return False
    despierto = None
    try:
        try:  # mantiene el Mac despierto mientras dura la lectura (máx. 3 h)
            despierto = subprocess.Popen(["caffeinate", "-i", "-s", "-t", "10800"])
        except Exception:
            pass
        with con() as c:
            libros = c.execute("SELECT asin, titulo, mercados FROM libros WHERE activo=1").fetchall()
        pares = [(l["asin"], m, l["titulo"]) for l in libros if not asins or l["asin"] in asins
                 for m in l["mercados"].split(",") if m in MERCADOS]
        random.shuffle(pares)
        progreso.update(activo=True, hechos=0, total=len(pares), actual="", inicio=int(time.time()), aviso="")
        if programado:
            cfg_set("ultimo_ciclo", int(time.time()))
        bloqueos = 0
        for i, (asin, mercado, titulo) in enumerate(pares):
            progreso["actual"] = f"{(titulo or asin)[:40]} · {mercado}"
            estado, d = descargar(asin, mercado)
            if estado == "bloqueado":  # un reintento tranquilo y, si insiste, se deja para el próximo ciclo
                time.sleep(random.uniform(20, 35))
                estado, d = descargar(asin, mercado)
            guardar_lectura(asin, mercado, estado, d)
            progreso["hechos"] = i + 1
            bloqueos = bloqueos + 1 if estado == "bloqueado" else 0
            if bloqueos >= 4:
                progreso["aviso"] = "Amazon está limitando las lecturas; se reintentará en el próximo ciclo."
                break
            if i + 1 < len(pares):
                time.sleep(random.uniform(2.5, 5.0))
        if programado:  # una lectura larga que cruza de franja no debe provocar otra nada más acabar
            cfg_set("ultimo_ciclo", int(time.time()))
        return True
    finally:
        progreso.update(activo=False, actual="")
        publicar()
        if despierto:
            despierto.terminate()
        _ciclo_lock.release()


def publicar():
    """Sube los datos al panel web (GitHub Pages) si existe la carpeta github/ enlazada a un repositorio."""
    carpeta = RAIZ / "github"
    if DB_RUTA.name != "bsr.sqlite" or not (carpeta / ".git").exists():
        return
    try:
        d = datos(0)
        d["progreso"] = {"activo": False, "hechos": 0, "total": 0, "actual": "", "aviso": ""}
        (carpeta / "datos.json").write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        git = ["git", "-C", str(carpeta)]
        subprocess.run(git + ["add", "datos.json"], capture_output=True, timeout=60)
        if subprocess.run(git + ["diff", "--cached", "--quiet"], timeout=60).returncode:
            subprocess.run(git + ["commit", "-q", "-m", time.strftime("Lectura BSR %Y-%m-%d %H:%M")], capture_output=True, timeout=60)
        subprocess.run(git + ["pull", "-q", "--rebase", "-X", "theirs"], capture_output=True, timeout=120)
        r = subprocess.run(git + ["push", "-q"], capture_output=True, timeout=120)
        if r.returncode:
            print("publicar:", r.stderr.decode(errors="ignore")[-300:])
    except Exception as e:
        print("publicar:", e)


def franja(horas=None):
    """Inicio (ts) de la franja de reloj actual: con 4 h -> 00:00, 04:00, 08:00... hora local."""
    horas = float(horas or cfg("intervalo_horas", 4))
    t = time.localtime()
    medianoche = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))
    paso = horas * 3600
    return int(medianoche + ((time.time() - medianoche) // paso) * paso), int(paso)


def programador():
    time.sleep(3)
    while True:
        try:
            inicio, _ = franja()
            if cfg("ultimo_ciclo", 0) < inicio and not progreso["activo"]:
                ciclo(programado=True)
        except Exception as e:  # el programador no debe morir nunca
            print("programador:", e)
        time.sleep(5)  # sondeo corto: tras un despertar programado hay poco margen antes de que el Mac vuelva a dormirse


# ---------------------------------------------------------------- API
def extraer_asins(texto):
    """Acepta ASINs sueltos o enlaces de Amazon. -> [(asin, mercado|None)]"""
    vistos, salida = set(), []
    for token in re.split(r"[\s,;]+", texto.strip()):
        if not token:
            continue
        mercado = None
        m = re.search(r"amazon\.([a-z.]+?)/", token)
        if m:
            mercado = DOMINIO_A_MERCADO.get("amazon." + m.group(1))
        m = re.search(r"/(?:dp|gp/product|product|gp/aw/d)/([A-Za-z0-9]{10})", token) \
            or re.fullmatch(r"([A-Za-z0-9]{10})", token)
        if m:
            asin = m.group(1).upper()
            if asin not in vistos:
                vistos.add(asin)
                salida.append((asin, mercado))
    return salida


def datos(dias):
    desde = int(time.time()) - int(dias * 86400) if dias else 0
    with con() as c:
        libros = [dict(f) for f in c.execute("SELECT * FROM libros ORDER BY marca, titulo, asin")]
        for l in libros:
            l["mercados"] = [m for m in l["mercados"].split(",") if m]
        lect = c.execute("SELECT asin, mercado, ts, bsr FROM lecturas WHERE ts>=? AND bsr IS NOT NULL ORDER BY ts",
                         (desde,)).fetchall()
        ult = c.execute("""SELECT l.asin, l.mercado, l.ts, l.bsr, l.estado, l.categorias, l.valoracion, l.resenas
                           FROM lecturas l JOIN (SELECT asin, mercado, MAX(id) mid FROM lecturas GROUP BY asin, mercado) u
                           ON l.id = u.mid""").fetchall()
    return {
        "ahora": int(time.time()),
        "libros": libros,
        "mercados": [{"cod": k, "dominio": v[0], "nombre": v[1], "bandera": v[2]} for k, v in MERCADOS.items()],
        "mercados_defecto": cfg("mercados_defecto", MERCADOS_DEFECTO),
        "intervalo_horas": cfg("intervalo_horas", 4),
        "ultimo_ciclo": cfg("ultimo_ciclo", 0),
        "proximo": sum(franja()),
        "progreso": progreso,
        "lecturas": [[f["asin"], f["mercado"], f["ts"], f["bsr"]] for f in lect],
        "ultimas": [{**dict(f), "categorias": json.loads(f["categorias"] or "[]")} for f in ult],
    }


class Manejador(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, codigo=200):
        cuerpo = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_GET(self):
        ruta, _, q = self.path.partition("?")
        params = dict(p.split("=", 1) for p in q.split("&") if "=" in p)
        if ruta == "/api/datos":
            try:
                dias = float(params.get("dias", 30))
            except ValueError:
                dias = 30
            return self._json(datos(dias))
        if ruta == "/api/progreso":
            return self._json(progreso)
        nombre = "index.html" if ruta == "/" else ruta.lstrip("/")
        archivo = (WEB / nombre).resolve()
        if WEB not in archivo.parents or not archivo.is_file():
            self.send_error(404)
            return
        tipo = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".svg": "image/svg+xml"}.get(archivo.suffix, "application/octet-stream")
        cuerpo = archivo.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", tipo + "; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_POST(self):
        # solo peticiones del propio panel
        origen = self.headers.get("Origin", "")
        if origen and not re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", origen):
            return self._json({"error": "origen no permitido"}, 403)
        try:
            n = int(self.headers.get("Content-Length", 0))
            b = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json({"error": "petición inválida"}, 400)
        ruta = self.path

        if ruta == "/api/libros":  # alta en bloque
            pares = extraer_asins(b.get("texto", ""))
            if not pares:
                return self._json({"error": "No he encontrado ningún ASIN válido (10 caracteres) ni enlace de Amazon."}, 400)
            mercados = [m for m in b.get("mercados", []) if m in MERCADOS] or cfg("mercados_defecto", MERCADOS_DEFECTO)
            marca = (b.get("marca") or "").strip()
            nuevos = []
            with _db_lock, con() as c:
                for asin, mk in pares:
                    ms = list(mercados) + ([mk] if mk and mk not in mercados else [])
                    cur = c.execute("INSERT OR IGNORE INTO libros(asin, marca, mercados, creado) VALUES(?,?,?,?)",
                                    (asin, marca, ",".join(ms), int(time.time())))
                    if cur.rowcount:
                        nuevos.append(asin)
            if nuevos:
                threading.Thread(target=self._leer_cuando_pueda, args=(nuevos,), daemon=True).start()
            return self._json({"nuevos": nuevos, "repetidos": [a for a, _ in pares if a not in nuevos]})

        if ruta == "/api/libro":  # edición
            asin = b.get("asin", "")
            campos, vals = [], []
            if "titulo" in b:
                campos.append("titulo=?"); vals.append(str(b["titulo"]).strip())
            if "marca" in b:
                campos.append("marca=?"); vals.append(str(b["marca"]).strip())
            if "mercados" in b:
                campos.append("mercados=?"); vals.append(",".join(m for m in b["mercados"] if m in MERCADOS))
            if "activo" in b:
                campos.append("activo=?"); vals.append(1 if b["activo"] else 0)
            if campos:
                with _db_lock, con() as c:
                    c.execute(f"UPDATE libros SET {', '.join(campos)} WHERE asin=?", (*vals, asin))
            return self._json({"ok": True})

        if ruta == "/api/libro/borrar":
            with _db_lock, con() as c:
                c.execute("DELETE FROM libros WHERE asin=?", (b.get("asin", ""),))
                c.execute("DELETE FROM lecturas WHERE asin=?", (b.get("asin", ""),))
            return self._json({"ok": True})

        if ruta == "/api/actualizar":
            if progreso["activo"]:
                return self._json({"ok": False, "motivo": "Ya hay una actualización en marcha."})
            asins = b.get("asins") or None
            threading.Thread(target=ciclo, kwargs={"asins": asins, "programado": not asins}, daemon=True).start()
            return self._json({"ok": True})

        if ruta == "/api/config":
            if "intervalo_horas" in b:
                cfg_set("intervalo_horas", max(1.0, min(24.0, float(b["intervalo_horas"]))))
            if "mercados_defecto" in b:
                cfg_set("mercados_defecto", [m for m in b["mercados_defecto"] if m in MERCADOS])
            return self._json({"ok": True})

        self._json({"error": "ruta desconocida"}, 404)

    @staticmethod
    def _leer_cuando_pueda(asins):
        for _ in range(240):  # espera a que termine el ciclo en curso (máx. ~1 h)
            if ciclo(asins=asins):
                return
            time.sleep(15)


def main():
    global DB_RUTA
    ap = argparse.ArgumentParser()
    ap.add_argument("--puerto", type=int, default=8770)
    ap.add_argument("--db", default=str(DB_RUTA))
    ap.add_argument("--no-abrir", action="store_true")
    ap.add_argument("--sin-programador", action="store_true")
    a = ap.parse_args()
    DB_RUTA = Path(a.db)
    iniciar_db()
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", a.puerto), Manejador)
    except OSError:
        print(f"El monitor ya está en marcha en http://127.0.0.1:{a.puerto}")
        if not a.no_abrir:
            webbrowser.open(f"http://127.0.0.1:{a.puerto}")
        return
    if not a.sin_programador:
        threading.Thread(target=programador, daemon=True).start()
    print(f"Monitor BSR en http://127.0.0.1:{a.puerto}  (Ctrl+C para parar)")
    if not a.no_abrir:
        webbrowser.open(f"http://127.0.0.1:{a.puerto}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
