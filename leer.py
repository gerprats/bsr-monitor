#!/usr/bin/env python3
"""Lectura programada para GitHub Actions: lee el BSR de cada libro×país de libros.json
y actualiza datos.json (lo que muestra el panel). Reutiliza el lector de servidor.py."""
import json
import random
import time
from pathlib import Path

from servidor import MERCADOS, MERCADOS_DEFECTO, descargar

RAIZ = Path(__file__).resolve().parent
F_DATOS, F_LIBROS = RAIZ / "datos.json", RAIZ / "libros.json"
INTERVALO_HORAS = 4

config = json.loads(F_LIBROS.read_text(encoding="utf-8"))
datos = json.loads(F_DATOS.read_text(encoding="utf-8")) if F_DATOS.exists() else {}
previos = {l["asin"]: l for l in datos.get("libros", [])}
lecturas = datos.get("lecturas", [])
ultimas = {(u["asin"], u["mercado"]): u for u in datos.get("ultimas", [])}
ciclos = datos.get("ciclos", [])

libros = []
for c in config["libros"]:
    p = previos.get(c["asin"], {})
    libros.append({
        "asin": c["asin"], "marca": c.get("marca", ""),
        "titulo": c.get("titulo") or p.get("titulo", ""), "portada": p.get("portada", ""),
        "mercados": [m for m in c.get("mercados", MERCADOS_DEFECTO) if m in MERCADOS],
        "activo": 0 if c.get("pausado") else 1, "creado": p.get("creado", int(time.time())),
    })

pares = [(l, m) for l in libros if l["activo"] for m in l["mercados"]]
random.shuffle(pares)
inicio, cuenta, seguidos = int(time.time()), {}, 0
for i, (l, m) in enumerate(pares):
    estado, d = descargar(l["asin"], m)
    if estado == "bloqueado":
        time.sleep(random.uniform(20, 35))
        estado, d = descargar(l["asin"], m)
    ts = int(time.time())
    cuenta[estado] = cuenta.get(estado, 0) + 1
    print(f"{l['asin']} {m}: {estado} {d.get('bsr') or ''}", flush=True)
    if d.get("bsr"):
        lecturas.append([l["asin"], m, ts, d["bsr"]])
    if d.get("titulo") and not l["titulo"]:
        l["titulo"] = d["titulo"]
    if d.get("portada") and not l["portada"]:
        l["portada"] = d["portada"]
    ultimas[(l["asin"], m)] = {"asin": l["asin"], "mercado": m, "ts": ts, "bsr": d.get("bsr"), "estado": estado,
                               "categorias": d.get("categorias") or [], "valoracion": d.get("valoracion"),
                               "resenas": d.get("resenas")}
    seguidos = seguidos + 1 if estado == "bloqueado" else 0
    if seguidos >= 4:
        print("Amazon está limitando: se corta este ciclo.")
        break
    if i + 1 < len(pares):
        time.sleep(random.uniform(2.5, 5.0))

asins = {l["asin"] for l in libros}
ciclos = (ciclos + [{"ts": inicio, "total": len(pares), **cuenta}])[-200:]
F_DATOS.write_text(json.dumps({
    "ahora": int(time.time()), "libros": sorted(libros, key=lambda l: (l["marca"], l["titulo"], l["asin"])),
    "mercados": [{"cod": k, "dominio": v[0], "nombre": v[1], "bandera": v[2]} for k, v in MERCADOS.items()],
    "mercados_defecto": MERCADOS_DEFECTO, "intervalo_horas": INTERVALO_HORAS, "ultimo_ciclo": inicio,
    "progreso": {"activo": False, "hechos": 0, "total": 0, "actual": "", "aviso": ""},
    "lecturas": [x for x in lecturas if x[0] in asins],
    "ultimas": [u for k, u in ultimas.items() if k[0] in asins],
    "ciclos": ciclos,
}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("RESUMEN", json.dumps(cuenta), "de", len(pares))
