# Claves API gratuitas para visión — briefing

> Objetivo: tener varios proveedores de **modelos multimodales (imagen + instrucción → JSON)** para
> rotar (gratis primero, de pago como último recurso) y no depender solo de Gemini (que agota su cuota
> diaria). Lo que necesitamos NO es "reconocimiento de imágenes" clásico (etiquetas/objetos) sino un
> **LLM con visión** que lea ISBN/código de barras y razone metadatos. Ojo: **el NAS (Atom D525) no puede
> correr modelos locales** — todo va por API. Las cuotas cambian: verifica al crear la clave.
>
> Sugerencia de orden en la rotación: **Gemini → Groq → OpenRouter (modelos `:free`) → (Mistral / GitHub
> Models / Cloudflare) → de pago**. Y antes de llamar a NINGUNA visión, intentar decodificar el código de
> barras EN LOCAL (zxing, sin clave) — elimina la mayoría de llamadas.

Convención de variables `.env` propuesta (las cablearemos en `conVision`):
`GEMINI_API_KEY`, `GEMINI_API_FREE_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`,
`GITHUB_MODELS_TOKEN`, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, `HF_API_TOKEN`, `NVIDIA_API_KEY`,
`COHERE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OCRSPACE_API_KEY`.

---

## 1) Google Gemini  (ya en uso · gratis)
- Web: **aistudio.google.com** → inicia sesión con cuenta Google.
- "Get API key" → "Create API key" (en un proyecto nuevo o existente).
- Gratis con límites por minuto/día (RPM/RPD/TPM). Es lo que se agota.
- Modelo visión: `gemini-2.5-flash`. → `GEMINI_API_KEY` / `GEMINI_API_FREE_KEY`.

## 2) Groq  (gratis, rápido · MUY recomendado)
- Web: **console.groq.com** → sign up (Google/GitHub).
- "API Keys" → "Create API Key" → cópiala (solo se muestra una vez).
- Free tier con límites generosos; API **compatible con OpenAI** (`https://api.groq.com/openai/v1`).
- Modelo visión: `meta-llama/llama-4-scout-17b-16e-instruct` o el Llama-Vision vigente (mira "Models").
- → `GROQ_API_KEY`.

## 3) OpenRouter  (agregador · modelos gratis · IDEAL para rotar)
- Web: **openrouter.ai** → sign up → "Keys" → "Create Key".
- Una sola clave da acceso a MUCHOS modelos; hay variantes **`:free`** (con límite diario).
- API **compatible con OpenAI** (`https://openrouter.ai/api/v1`). Cabeceras opcionales `HTTP-Referer`/`X-Title`.
- Modelos visión gratis típicos: `google/gemini-2.0-flash-exp:free`, `meta-llama/llama-3.2-11b-vision-instruct:free`,
  `qwen/qwen2.5-vl-...:free` (mira la lista filtrando por "free" + "vision").
- → `OPENROUTER_API_KEY`.

## 4) Mistral (La Plateforme)  (Pixtral · tier gratis)
- Web: **console.mistral.ai** → sign up → "API Keys" → crea una. (Puede pedir teléfono.)
- Plan "Experiment" gratuito con límites; Pixtral es bueno con documentos/escaneos.
- API casi compatible OpenAI (`https://api.mistral.ai/v1`). Modelo visión: `pixtral-12b-2409` (o el vigente).
- → `MISTRAL_API_KEY`.

## 5) GitHub Models  (gratis para devs · da acceso a modelos "de pago")
- Web: **github.com/marketplace/models** (con cuenta GitHub).
- Necesita un **Personal Access Token** (github.com → Settings → Developer settings → Tokens). Con permisos
  mínimos (los "models" no requieren scopes de repo; un token fine-grained básico vale).
- Endpoint Azure AI Inference (`https://models.inference.ai.azure.com`), compatible OpenAI.
- Modelos visión: `gpt-4o`, `gpt-4o-mini`, `Llama-3.2-11B-Vision-Instruct`, `Phi-3.5-vision-instruct`.
- → `GITHUB_MODELS_TOKEN`.

## 6) Cloudflare Workers AI  (asignación diaria gratis)
- Web: **dash.cloudflare.com** → crea cuenta → menú "AI" → "Workers AI".
- Necesitas el **Account ID** (en la barra lateral) y un **API Token** (My Profile → API Tokens →
  Create Token → plantilla "Workers AI" o permiso `Account.Workers AI:Read/Edit`).
- Endpoint: `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}`.
- Modelos visión: `@cf/meta/llama-3.2-11b-vision-instruct`, `@cf/llava-hf/llava-1.5-7b-hf`.
- → `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

## 7) Hugging Face Inference  (gratis, con límites/arranque en frío)
- Web: **huggingface.co** → sign up → Settings → "Access Tokens" → "New token" (tipo *read*).
- Inference API/Providers gratis con límites; algunos modelos exigen aceptar su licencia en su página.
- Modelos visión: `Qwen/Qwen2-VL-7B-Instruct`, `meta-llama/Llama-3.2-11B-Vision-Instruct`.
- → `HF_API_TOKEN`.

## 8) NVIDIA NIM (build.nvidia.com)  (créditos gratis)
- Web: **build.nvidia.com** → cuenta NVIDIA → elige un modelo → "Get API Key".
- Créditos iniciales gratis; endpoint `https://integrate.api.nvidia.com/v1`, compatible OpenAI.
- Modelos visión: Llama-3.2-Vision, Phi-3.5-vision, etc. (los que marca la web).
- → `NVIDIA_API_KEY`.

## 9) Cohere  (Aya Vision · clave de prueba)
- Web: **dashboard.cohere.com** → sign up → "API Keys" → usa la *trial key* (gratis, con límites).
- SDK propio; modelo visión: `c4ai-aya-vision-8b` / `aya-vision-32b`.
- → `COHERE_API_KEY`.

## De pago (último recurso de la rotación)
- **OpenAI** (`platform.openai.com` → API keys): `gpt-4o-mini` (visión) barato. → `OPENAI_API_KEY`.
- **Anthropic** (`console.anthropic.com` → API keys): `claude-haiku` (visión). → `ANTHROPIC_API_KEY`.
- (Sin tier gratis real; solo créditos de prueba puntuales.)

## Solo-texto que ayudan (subtarea "leer el ISBN/ISSN impreso")
- **OCR.space**: **ocr.space/ocrapi** → "Register for free API key" (llega por email). 25k/mes gratis.
  → `OCRSPACE_API_KEY`.
- **Google Cloud Vision** (1k/mes) y **Azure AI Vision Read** (5k/mes): requieren proyecto cloud + facturación
  activada aunque el tramo sea gratis (más fricción).

## Sin clave (gratis, local) — hacerlo SIEMPRE primero
- **Código de barras** EAN‑13 (`977`→ISSN, `978/979`→ISBN): decodificar en el servidor con `zxing-wasm`
  sobre el recorte de la cubierta ANTES de gastar una llamada de visión. C/WASM, apto para el Atom.

---

### Resumen para mañana (qué traer)
Crea y pégame (o ponlas en `.env`) al menos: **Groq**, **OpenRouter**, y si puedes **Mistral** y
**GitHub Models**. Con esas + Gemini la rotación gratuita tiene margen de sobra. Cloudflare/HF/NVIDIA/Cohere
son extras. OpenAI/Anthropic solo si quieres una red de pago de último recurso.
