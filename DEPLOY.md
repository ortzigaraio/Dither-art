# Publicar HORAIN (pasos manuales del dueño)

Esto lo haces tú una sola vez desde GitHub y Cloudflare. El código no necesita build: GitHub Pages sirve la carpeta tal cual.

Nombres que usa esta guía (cámbialos aquí, en `src/config.js` y en `worker/counter/wrangler.toml` si eliges otros):

| Qué | Valor |
|---|---|
| Web | `https://dither.ortzigar.org` |
| Contador de visitas | `https://count.ortzigar.org` |
| Usuario / repo de GitHub | `ortzigaraio` / `Dither-art` |

---

## 1. Hacer público el repositorio

GitHub Pages gratis necesita un repo público. El repo no contiene secretos: solo código, fuentes con licencia libre y el logo.

GitHub → el repo → **Settings** → **General** → al final, **Danger Zone** → **Change repository visibility** → **Public**.

## 2. Llevar el código a `main`

Fusiona el pull request de la rama de trabajo en `main`.

## 3. Activar GitHub Pages

Repo → **Settings** → **Pages** → *Build and deployment*:
- **Source**: Deploy from a branch
- **Branch**: `main`, carpeta `/ (root)` → **Save**

En 1–2 minutos estará en `https://ortzigaraio.github.io/Dither-art/`. Comprueba que carga antes de seguir.

## 4. Dominio propio con Cloudflare

### 4.1 Verificar el dominio en GitHub (evita que otra cuenta lo secuestre)
1. GitHub → tu avatar → **Settings** → **Pages** (en la sección "Code, planning, and automation") → **Add a domain** → `ortzigar.org`.
2. GitHub te da un registro **TXT** (nombre tipo `_github-pages-challenge-ortzigaraio`) y un valor.
3. Cloudflare → `ortzigar.org` → **DNS** → **Records** → **Add record**: tipo `TXT`, nombre y contenido los que dio GitHub → **Save**.
4. Vuelve a GitHub y pulsa **Verify** (puede tardar unos minutos).

### 4.2 Registro DNS de la web
Cloudflare → `ortzigar.org` → **DNS** → **Add record**:

| Tipo | Nombre | Destino | Proxy |
|---|---|---|---|
| `CNAME` | `dither` | `ortzigaraio.github.io` | **DNS only** (nube gris) |

Déjalo en **DNS only**: así GitHub puede emitir y renovar el certificado HTTPS sin problemas.

### 4.3 Conectar el dominio en GitHub
1. Repo → **Settings** → **Pages** → **Custom domain**: `dither.ortzigar.org` → **Save**.
   GitHub crea un commit con el archivo `CNAME` en `main`. Es normal; no lo borres.
2. Espera a que diga **DNS check successful**.
3. Marca **Enforce HTTPS**. El certificado puede tardar entre 15 minutos y 1 hora; si la casilla está gris, espera y recarga.

> ¿Prefieres el dominio raíz `ortzigar.org` en vez de un subdominio? En lugar del CNAME de 4.2 crea, en **DNS only**,
> 4 registros `A` hacia `185.199.108.153`, `185.199.109.153`, `185.199.110.153` y `185.199.111.153`, y 4 `AAAA` hacia
> `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153` y `2606:50c0:8003::153`. Pon `ortzigar.org` como
> Custom domain, y cambia también `ALLOWED_ORIGINS` en el Worker y `siteUrl` en `src/config.js`.

## 5. Contador de visitas (Cloudflare Worker + D1)

Necesitas Node.js 18 o superior en tu ordenador. Desde la carpeta del repo:

```bash
cd worker/counter
npx wrangler login                                   # abre el navegador para autorizar tu cuenta de Cloudflare
npx wrangler d1 create horain-counter                # imprime un database_id
```

Copia ese `database_id` en `worker/counter/wrangler.toml` (sustituye `REPLACE_WITH_THE_ID_PRINTED_BY_wrangler_d1_create`). Después:

```bash
npx wrangler d1 execute horain-counter --remote --file=schema.sql   # crea las tablas
npx wrangler deploy                                                 # publica el Worker en count.ortzigar.org
```

Si `wrangler deploy` se queja del bloque `[[ratelimits]]`, bórralo de `wrangler.toml` y repite. El contador funciona igual,
solo que sin el límite de 10 peticiones por minuto por IP.

Pruébalo:

```bash
curl https://count.ortzigar.org/count
# → {"total":0,"today":0}
curl -X POST -H "Origin: https://dither.ortzigar.org" https://count.ortzigar.org/hit
# → {"total":1,"today":1}
```

Por último, activa el contador en la web: en `src/config.js` pon `counterUrl: 'https://count.ortzigar.org'`, y haz commit a `main`.
Mientras `counterUrl` esté vacío, el contador simplemente no aparece.

> Privacidad: el Worker solo guarda dos números (total y por día). No guarda IPs, user-agents ni cookies.

## 6. Comprobación final

- [ ] `https://dither.ortzigar.org` carga con candado (HTTPS) y el logo espino en la cabecera.
- [ ] Soltar una imagen abre el estudio y el modo ASCII responde a los controles.
- [ ] La consola del navegador no muestra errores ni avisos de CSP.
- [ ] El contador del pie muestra un número, y al recargar el mismo día no sube.
- [ ] `https://ortzigaraio.github.io/Dither-art/` redirige al dominio propio.
