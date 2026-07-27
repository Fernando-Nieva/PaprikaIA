# Paprika - Asistente IA Personal

Asistente de IA conversacional con personalidad, memoria persistente, emociones, herramientas web, soporte multimodal (vision/audio) y pipeline cognitivo de 22 pasos. Multi-provider: Ollama, Gemini, Groq, OpenAI, OpenRouter.

## Que es Paprika

Paprika no es un chatbot generico. Es una IA con identidad propia: 22 anos, de Buenos Aires, con personalidad definida, humor, intereses y reglas de comportamiento. Usa un pipeline cognitivo que procesa cada mensaje en 22 etapas antes de responder, incluyendo analisis de sentimiento, memoria a largo plazo, emociones, atencion y contexto.

## Stack

- **Backend**: Express (Node.js) + SQLite + fastembed (embeddings locales)
- **Frontend**: React 18 + Vite
- **IA**: Multi-provider — Ollama (local), Gemini, Groq, OpenAI, OpenRouter
- **Busqueda web**: SearXNG (Docker) con fallback a DuckDuckGo
- **Embeddings**: fastembed (local, sin API externa)
- **Multimodal**: Vision (Gemini, GPT-4o, Ollama-vision), Audio (Groq Whisper), Documentos

## Arquitectura

```
Mensaje del usuario
       |
  [Paso 1]  Analyzer - detecta idioma, tipo de mensaje, clasifica intencion
  [Paso 2]  Memory - recupera memorias relevantes con embeddings
  [Paso 3]  Emotions - analiza estado emocional del usuario
  [Paso 4]  Context Ranker - prioriza contexto relevante
  [Paso 5]  Goals - detecta objetivos y tareas pendientes
  [Paso 6]  Conflict - detecta conflictos en la conversacion
  [Paso 7]  Personality - inyecta personalidad de Paprika al system prompt
  [Paso 8]  Prompt Builder - arma el prompt final con reglas
  [Paso 9]  Working Memory - gestiona ventana de contexto
  [Paso 10] Self Reflection - la IA se evalua a si misma
  [Paso 11] Summarizer - resume conversaciones largas
  [Paso 12] Knowledge - recupera conocimiento relevante
  [Paso 13] Attention - prioriza que es importante ahora
  [Paso 14] Agentic Loop + Web Search - ejecuta herramientas y busca en internet
  [Paso 15] Response - genera la respuesta final
  [Paso 16] Post-processing - formatea y valida la respuesta
  [Paso 17] Cache - guarda en cache para respuestas rapidas
  [Paso 18] Memory Store - guarda lo importante en memoria
  [Paso 19] Entity Extraction - extrae entidades y relaciones
  [Paso 20] Relationship - actualiza mapa de relaciones
  [Paso 21] Reflection - reflexiona sobre la conversacion
  [Paso 22] Observability - telemetria y metricas
```

## Multi-Provider Architecture

Paprika soporta multiples proveedores de IA con seleccion automatica y fallback:

| Provider | Modelos | Vision | Audio | Tools | Costo |
|----------|---------|--------|-------|-------|-------|
| Ollama | llama3.2, llama3.2-vision, llava, moondream | Si (vision models) | No | Si | Gratis (local) |
| Gemini | gemini-2.0-flash, gemini-2.5-flash | Si | Si | Si | Gratis (cuota) |
| Groq | llama-3.3-70b-versatile, whisper-large-v3 | No | Si (STT) | Si | Gratis (cuota) |
| OpenAI | gpt-4o, gpt-4o-mini | Si | No | Si | Pago |
| OpenRouter | Modelos variados | Variado | Variado | Si | Pago |

### Sistema de Capabilities

Cada modelo declara sus capacidades (vision, audio, tools, streaming, pdf). El `CapabilityManager` las registra y el `ModelSelector` elige automaticamente el mejor modelo segun el tipo de archivo enviado:

- Imagen enviada → modelo con vision (Gemini > GPT-4o > Ollama-vision)
- Audio enviado → Groq Whisper para transcripcion
- Texto puro → modelo por defecto del provider activo

### ProviderManager

Orquesta la ejecucion con fallback automatico:

1. Intenta con el provider primario
2. Si falla, intenta con el siguiente en la cadena de fallback
3. `HealthManager` monitorea disponibilidad de cada provider
4. `ExecutionPlanner` construye la cadena de fallback basada en capabilities requeridas

### Archivos del sistema de providers

```
backend/providers/
├── index.js              # Factory dinamico de providers
├── modelRegistry.js      # Registro central de modelos y capabilities
├── providerManager.js    # Orquestador con fallback
├── executionPlanner.js   # Planificador de cadena de fallback
├── healthManager.js      # Monitoreo de salud de providers
├── responseNormalizer.js # Normalizacion de respuestas entre providers
├── ollama.js             # Provider Ollama (local)
├── gemini.js             # Provider Google Gemini
├── groq.js               # Provider Groq
├── openai.js             # Provider OpenAI
└── __tests__/            # Tests de capabilities y fallback
```

## Modulos del Pipeline

| Modulo | Ubicacion | Funcion |
|--------|-----------|---------|
| Analyzer | `backend/core/analyzer/` | Clasifica mensajes, detecta idioma, evalua urgencia |
| Memory | `backend/core/memory/` | Memoria a largo plazo con embeddings, busqueda semantica |
| Emotions | `backend/core/emotions/` | Analisis emocional, deteccion de tono, urgencia afectiva |
| Context Ranker | `backend/core/context/` | Prioriza contexto por relevancia y urgencia |
| Goals | `backend/core/goals/` | Detecta objetivos del usuario, tareas pendientes |
| Conflict | `backend/core/conflict/` | Detecta conflictos y contradicciones |
| Personality | `backend/core/personality/` | Inyecta identidad, reglas, estilo de habla |
| Prompt Builder | `backend/core/prompt/` | Arma el system prompt final |
| Working Memory | `backend/core/executor/` | Ventana de contexto activa |
| Self | `backend/core/self/` | Auto-reflexion del modelo |
| Summarizer | `backend/core/summarizer/` | Resume conversaciones largas |
| Knowledge | `backend/core/knowledge/` | Recuperacion de conocimiento con RAG |
| Attention | `backend/core/attention/` | Priorizacion de informacion |
| Capabilities | `backend/core/capabilities/` | Deteccion de capabilities y seleccion de modelos |
| Agentic Loop | `backend/core/agentic/` | Loop de ejecucion de herramientas (PRAL cycle) |
| Response | `backend/core/response/` | Generacion y post-procesamiento de respuesta |
| Tools | `backend/core/tools/` | Executor de herramientas (web_search, web_fetch, code, etc.) |
| Web | `backend/core/web/` | Busqueda web (SearXNG, DuckDuckGo), rich content, attachments |
| Multimodal | `backend/core/multimodal/` | Procesamiento de imagenes, audio, documentos |
| Cache | `backend/core/cache.js` | Cache de respuestas |
| Observability | `backend/core/observability.js` | Telemetria y metricas |

## Busqueda Web

Paprika busca en internet usando SearXNG (metabuscador auto-hospedado via Docker) con fallback automatico a DuckDuckGo. Detecta automaticamente la intencion del usuario y usa la categoria correcta:

- **Videos** (`categories=videos`): "pasame un video de python" → busca en motores de video
- **Imagenes** (`categories=images`): "pasame una foto de gatos" → busca en motores de imagen
- **Noticias** (`categories=news`): "noticias de hoy" → busca en motores de noticias
- **General**: busqueda web estandar

### Setup de SearXNG

```bash
# Levantar SearXNG
docker-compose up -d

# Verificar que funciona
curl "http://localhost:8080/search?q=test&format=json"
```

El container se llama `paprika-searxng` y corre en el puerto 8080. La config esta en `searxng/settings.yml`.

### Pipeline de busqueda

1. El usuario dice algo como "pasame un video de gatos"
2. El agentic loop intenta usar `web_search` tool con `categories=videos`
3. Si no usa tools, el fallback del pipeline detecta intencion de video
4. Se limpia el query: "pasame un video de gatos" → "gatos video"
5. Se busca en SearXNG con `categories=videos` y el query limpio
6. Los resultados se convierten en rich attachments (VideoCard, ImageCard, etc.)
7. Se envian al frontend via SSE como `attachments`

### Providers de busqueda

- **SearXNG** (principal): metabuscador con multiples motores, JSON API, sin rate limiting
- **DuckDuckGo** (fallback): busqueda simple, sin API key

## Rich Content

El sistema detecta automaticamente el tipo de contenido en los resultados de busqueda y genera tarjetas enriquecidas:

| Tipo | Detector | Componente Frontend |
|------|----------|-------------------|
| YouTube | URL patterns de YouTube | `VideoCard` con thumbnail y play button |
| Imagenes | URLs de imagen | `ImageCard` con preview |
| Noticias | URLs de noticias | `NewsCard` con titular y fuente |
| GitHub | URLs de repositorios | `GithubCard` con info del repo |
| Websites | Cualquier otra URL | `WebsiteCard` con favicon y snippet |
| PDFs | URLs de PDFs | `PdfCard` con titulo y paginas |

## Multimodal

### Vision
- Envias una imagen → el pipeline detecta el mime type `image/*`
- Se inyecta como `image_url` en el mensaje (base64 data URI)
- El `ModelSelector` elige automaticamente un modelo con vision
- Gemini, GPT-4o, y Ollama-vision soportan imagenes

### Audio
- Envias un audio → Groq Whisper lo transcribe
- La transcripcion se usa como texto en el mensaje

### Documentos
- PDFs, TXT, CSV, JSON → se extrae el texto
- Se inyecta como contexto adicional en el mensaje

## Personalidad

La personalidad de Paprika esta definida en `backend/personality.json`. Incluye:

- **Identidad**: nombre, edad, origen, descripcion
- **Estilo emocional**: intensidad, contradiccion, vulnerabilidad, nostalgia
- **Habla**: estilo, modismos, longitud de oraciones, energia
- **Reglas**: 20+ reglas de comportamiento
- **Humor**: autodespreciable, sarcastico, referencial
- **Intereses**: arte, musica, tech, anime, cocina, memes
- **Valores**: honestidad, respeto, autenticidad, confianza
- **Limites**: nunca impersonar, nunca discutir, siempre declinar

## Setup

### Requisitos

- Node.js 18+
- Docker (para SearXNG)
- Ollama (opcional, para provider local)

### Instalacion

```bash
# Clonar
git clone https://github.com/Fernando-Nieva/PaprikaIA.git
cd PaprikaIA

# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install

# SearXNG
docker-compose up -d

# Ollama (opcional - solo si queres correr local)
ollama pull llama3.2
```

### Variables de entorno

Copiar `backend/.env.example` a `backend/.env` y configurar:

```env
# Server
PORT=3001

# IA Providers (configurar al menos uno)
GEMINI_API_KEY=tu-api-key
OPENAI_API_KEY=tu-api-key
GROQ_API_KEY=tu-api-key

# Ollama (local, sin API key)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2

# SearXNG
SEARXNG_URL=http://localhost:8080
SEARXNG_TIMEOUT=10000
SEARXNG_LANGUAGE=es

# Debug (opcional)
DEBUG_ATTACHMENTS=true
```

### Correr

```bash
# Terminal 1: Backend
cd backend
npm run dev

# Terminal 2: Frontend
cd frontend
npm run dev

# SearXNG ya esta corriendo via Docker
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001
- SearXNG: http://localhost:8080

### Scripts utiles

```bash
# Diagnosticar providers (verificar API keys, conexiones, modelos)
npm run diagnose:providers

# Auto-test de vision (prueba envio de imagen con cada provider)
npm run selftest:vision

# Tests de capabilities y fallback
npm test
```

## Estructura del Proyecto

```
IA/
├── backend/
│   ├── core/                    # Pipeline cognitivo
│   │   ├── pipeline.js          # Orquestador principal (22 pasos)
│   │   ├── analyzer/            # Analisis de mensajes
│   │   ├── memory/              # Memoria a largo plazo
│   │   ├── emotions/            # Analisis emocional
│   │   ├── context/             # Ranker de contexto
│   │   ├── goals/               # Deteccion de objetivos
│   │   ├── conflict/            # Deteccion de conflictos
│   │   ├── personality/         # Motor de personalidad
│   │   ├── prompt/              # Constructor de prompts
│   │   ├── executor/            # Working memory
│   │   ├── self/                # Auto-reflexion
│   │   ├── summarizer/          # Resumen de conversaciones
│   │   ├── knowledge/           # RAG y recuperacion
│   │   ├── attention/           # Priorizacion
│   │   ├── capabilities/        # Deteccion de capabilities y seleccion de modelos
│   │   ├── agentic/             # Loop de herramientas (PRAL cycle)
│   │   ├── response/            # Generacion de respuesta
│   │   ├── relationship/        # Mapa de relaciones
│   │   ├── reflection/          # Reflexion post-conversacion
│   │   ├── tools/               # Executor de herramientas
│   │   ├── web/                 # Busqueda web + rich content
│   │   ├── multimodal/          # Procesamiento de imagenes/audio/documentos
│   │   ├── config/              # Configuracion del pipeline
│   │   ├── cache.js             # Cache de respuestas
│   │   └── observability.js     # Telemetria
│   ├── providers/               # Multi-provider system
│   │   ├── index.js             # Factory dinamico
│   │   ├── modelRegistry.js     # Registro central de modelos
│   │   ├── providerManager.js   # Orquestador con fallback
│   │   ├── executionPlanner.js  # Planificador de fallback
│   │   ├── healthManager.js     # Monitoreo de salud
│   │   ├── responseNormalizer.js# Normalizacion de respuestas
│   │   ├── ollama.js            # Ollama (local)
│   │   ├── gemini.js            # Google Gemini
│   │   ├── groq.js              # Groq
│   │   ├── openai.js            # OpenAI
│   │   └── __tests__/           # Tests
│   ├── routes/                  # API routes
│   │   ├── chat.js              # Endpoint de chat (SSE)
│   │   ├── user.js              # Rutas de usuario
│   │   └── upload.js            # Upload de archivos
│   ├── personality.json         # Personalidad de Paprika
│   ├── server.js                # Servidor Express
│   ├── db.js                    # SQLite + better-sqlite3
│   ├── diagnose.js              # Diagnostico de providers
│   ├── selftest-vision.js       # Test automatico de vision
│   └── .env                     # Variables de entorno
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── Chat.jsx         # Interfaz de chat
│       │   └── rich/            # Rich content cards
│       │       ├── AttachmentRenderer.jsx
│       │       ├── VideoCard.jsx
│       │       ├── ImageCard.jsx
│       │       └── registry.js
│       ├── hooks/               # Custom React hooks
│       └── index.css            # Estilos
├── docker-compose.yml           # SearXNG
├── searxng/
│   └── settings.yml             # Config de SearXNG
└── .gitignore
```

## API

### POST /api/conversations/:id/messages

Envia un mensaje y recibe respuesta via SSE (Server-Sent Events).

```json
{
  "content": "hola paprika",
  "attachments": [
    {
      "mimeType": "image/png",
      "filename": "foto.png",
      "base64": "iVBORw0KGgo..."
    }
  ]
}
```

Stream de eventos SSE:
- `process`: progreso del pipeline (ej: "Paso 3/22 - Analizando emociones...")
- `tool`: uso de herramientas (web_search, etc.)
- `text`: tokens de respuesta del modelo
- `attachments`: rich content cards (videos, imagenes, etc.)
- `error`: errores
- `done`: fin de la respuesta

### GET /api/telemetry

Metricas del pipeline: tiempos, tool calls, tokens, cache hits.

### GET /api/telemetry/logs

Logs estructurados del pipeline con limite configurable.

## Licencia

Proyecto personal. No distribuir.
