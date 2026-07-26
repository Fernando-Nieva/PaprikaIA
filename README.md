# Paprika - Asistente IA Personal

Asistente de IA conversacional con personalidad, memoria persistente, emociones, herramientas web y pipeline cognitivo de 22 pasos. Corre 100% local con Ollama.

## Que es Paprika

Paprika no es un chatbot generico. Es una IA con identidad propia: 22 anos, de Buenos Aires, con personalidad definida, humor, intereses y reglas de comportamiento. Usa un pipeline cognitivo que procesa cada mensaje en 22 etapas antes de responder, incluyendo analisis de sentimiento, memoria a largo plazo, emociones, atencion y contexto.

## Stack

- **Backend**: Express (Node.js) + SQLite + fastembed (embeddings locales)
- **Frontend**: React 18 + Vite
- **IA**: Ollama (local) con modelos Llama 3.2 / Gemma / Qwen
- **Busqueda web**: SearXNG (Docker) con fallback a DuckDuckGo
- **Embeddings**: fastembed (local, sin API externa)

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
| Agentic Loop | `backend/core/agentic/` | Loop de ejecucion de herramientas |
| Response | `backend/core/response/` | Generacion y post-procesamiento de respuesta |
| Tools | `backend/core/tools/` | Executor de herramientas (web_search, etc.) |
| Web | `backend/core/web/` | Busqueda web (SearXNG, DuckDuckGo) |
| Cache | `backend/core/cache.js` | Cache de respuestas |
| Observability | `backend/core/observability.js` | Telemetria y metricas |

## Busqueda Web

Paprika busca en internet usando SearXNG (metabuscador auto-hospedado via Docker) con fallback automatico a DuckDuckGo.

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
2. El sistema detecta que necesita busqueda web (regex con keywords)
3. Se limpia el query: "pasame un video de gatos" → "gatos video"
4. Se busca en SearXNG con el query limpio
5. Si SearXNG falla, se intenta con DuckDuckGo
6. Los resultados se formatean y se devuelven al usuario

### Providers

- **SearXNG** (principal): metabuscador con multiples motores, JSON API, sin rate limiting
- **DuckDuckGo** (fallback): busqueda simple, sin API key

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

## Modelo de IA

Paprika usa Ollama para correr modelos localmente. Modelos soportados:

- Llama 3.2 (recomendado, default)
- Gemma 2
- Qwen 2.5
- Cualquier modelo compatible con Ollama

### Configuracion

En `backend/.env`:

```env
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2
SEARXNG_URL=http://localhost:8080
```

## Setup

### Requisitos

- Node.js 18+
- Docker (para SearXNG)
- Ollama instalado y corriendo

### Instalacion

```bash
# Clonar
git clone <repo-url>
cd IA

# Backend
cd backend
npm install
cp .env.example .env  # configurar variables

# Frontend
cd ../frontend
npm install

# SearXNG
docker-compose up -d

# Ollama - descargar modelo
ollama pull llama3.2
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
│   │   ├── agentic/             # Loop de herramientas
│   │   ├── response/            # Generacion de respuesta
│   │   ├── relationship/        # Mapa de relaciones
│   │   ├── reflection/          # Reflexion post-conversacion
│   │   ├── tools/               # Executor de herramientas
│   │   ├── web/                 # Busqueda web
│   │   ├── multimodal/          # Procesamiento de imagenes/audio
│   │   ├── config/              # Configuracion del pipeline
│   │   ├── cache.js             # Cache de respuestas
│   │   └── observability.js     # Telemetria
│   ├── providers/               # Proveedores de IA
│   │   ├── ollama.js            # Ollama (local)
│   │   └── gemini.js            # Google Gemini (fallback)
│   ├── routes/                  # API routes
│   │   ├── chat.js              # Endpoint de chat
│   │   └── upload.js            # Upload de archivos
│   ├── personality.json         # Personalidad de Paprika
│   ├── server.js                # Servidor Express
│   ├── db.js                    # SQLite + better-sqlite3
│   └── .env                     # Variables de entorno
├── frontend/
│   └── src/
│       ├── components/
│       │   └── Chat.jsx         # Interfaz de chat
│       ├── hooks/               # Custom React hooks
│       └── index.css            # Estilos
├── docker-compose.yml           # SearXNG
├── searxng/
│   └── settings.yml             # Config de SearXNG
└── .gitignore
```

## API

### POST /api/chat

Envia un mensaje y recibe respuesta via SSE (Server-Sent Events).

```json
{
  "message": "hola paprika",
  "conversationId": "abc123"
}
```

Stream de eventos SSE:
- `tool`: progreso del pipeline (ej: "Paso 3/22 - Analizando emociones...")
- `text`: tokens de respuesta del modelo
- `done`: fin de la respuesta

### GET /api/telemetry

Metricas del pipeline: tiempos, tool calls, tokens, cache hits.

## Licencia

Proyecto personal. No distribuir.
