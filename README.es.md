# cvparse

Convierte CVs y currículums en JSON tipado y compatible con JSON Resume usando LLMs, con cualquier proveedor que soporte el Vercel AI SDK, incluidos modelos locales vía Ollama.

[![npm version](https://img.shields.io/npm/v/cvparse.svg)](https://www.npmjs.com/package/cvparse)
[![CI](https://img.shields.io/github/actions/workflow/status/Nikire/cvparse/ci.yml?branch=main&label=CI)](https://github.com/Nikire/cvparse/actions)
[![License: MIT](https://img.shields.io/github/license/Nikire/cvparse.svg)](https://github.com/Nikire/cvparse/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/node/v/cvparse.svg)](https://nodejs.org)

> **Estado: 0.0.1 — vista previa temprana.**
> Hoy cvparse acepta **solo texto plano**. Vos extraés el texto del PDF, DOCX o imagen y se lo pasás. La extracción de texto de PDF y DOCX integrada llega en 0.1, y un adaptador de OCR para documentos escaneados en 0.2. Ver la [hoja de ruta](#hoja-de-ruta). El schema y la API pueden cambiar antes de 0.1.

[English version](./README.md)

## Inicio rápido

### CLI, en local con Ollama

Requiere Node >= 22 y [Ollama](https://ollama.com) corriendo en tu máquina.

```bash
ollama pull llama3.1
npx cvparse ./cv.txt --pretty
```

`cvparse` usa por defecto Ollama en `http://localhost:11434/v1`. Nada sale de tu máquina.

Otros proveedores:

```bash
# OpenAI (lee OPENAI_API_KEY del entorno si se omite --api-key)
npx cvparse ./cv.txt --provider openai --model gpt-4o-mini --pretty

# Cualquier endpoint compatible con OpenAI (LM Studio, vLLM, Groq, OpenRouter, ...)
npx cvparse ./cv.txt --provider openai-compatible --base-url http://localhost:1234/v1 --model mi-modelo
```

Todos los flags:

| Flag | Valores | Notas |
| --- | --- | --- |
| `<file>` | ruta o `-` | CV en texto plano. `-` lee de stdin. Los archivos `.pdf`, `.docx` e imágenes se rechazan en 0.0.1 (salida 2) |
| `--provider` | `ollama` \| `openai` \| `openai-compatible` | Por defecto: `ollama` |
| `--model <id>` | cualquier id de modelo que conozca el proveedor | Por defecto: `llama3.1` (ollama), `gpt-4o-mini` (openai); obligatorio para `openai-compatible` |
| `--base-url <url>` | URL | Por defecto: `http://localhost:11434/v1` (ollama), `https://api.openai.com/v1` (openai); obligatorio para `openai-compatible` |
| `--api-key <key>` | string | Se envía como Bearer token. Si se omite, usa la variable de entorno `CVPARSE_API_KEY` (cualquier proveedor) u `OPENAI_API_KEY` (solo con `--provider openai`). La clave solo se envía a la base URL configurada: `https://api.openai.com/v1` por defecto con `--provider openai`; si sobrescribís `--base-url`, la clave se manda a ese host |
| `--lang` | `es` \| `en` \| `auto` | Pista del idioma del CV. Por defecto: `auto` |
| `--pretty` | flag | Indenta la salida JSON |
| `-h`, `--help` | flag | Imprime la ayuda por stderr |
| `-v`, `--version` | flag | Imprime la versión de cvparse |

El CLI imprime únicamente el objeto `resume` como JSON por **stdout**; los `warnings` van por **stderr** como líneas `warning:`, junto con la ayuda y los errores. Códigos de salida:

| Código | Significado |
| --- | --- |
| `0` | Éxito |
| `1` | Falló la extracción (error del proveedor, salida del modelo inválida) |
| `2` | Error de uso (argumentos incorrectos, archivo inexistente, tipo de archivo no soportado) |

Así se puede encadenar con pipes y scripts:

```bash
npx cvparse ./cv.txt | jq '.basics.name'
cat cv.txt | npx cvparse - --lang es
```

### Programático

```bash
npm install cvparse @ai-sdk/openai-compatible
```

`parseResume` recibe el texto del CV y cualquier modelo de lenguaje del AI SDK. Con Ollama todo corre en local:

```ts
import { readFile } from 'node:fs/promises';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { parseResume } from 'cvparse';

const ollama = createOpenAICompatible({
  name: 'ollama',
  baseURL: 'http://localhost:11434/v1',
  // Obligatorio: sin esto el proveedor manda `json_object` en vez del schema del CV
  // y `warnings` incluye un aviso `responseFormat`. Ollama >= 0.5, OpenAI, LM Studio
  // y vLLM lo soportan.
  supportsStructuredOutputs: true,
});

const text = await readFile('./cv.txt', 'utf8');

const { resume, usage, warnings } = await parseResume(text, {
  model: ollama('llama3.1'),
  language: 'auto', // 'es' | 'en' | 'auto'
});

console.log(resume.basics?.name);
console.log(resume.work?.[0]?.position);
```

O con OpenAI, a través del mismo paquete de proveedor:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { parseResume } from 'cvparse';

const openai = createOpenAICompatible({
  name: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  supportsStructuredOutputs: true,
});

const { resume } = await parseResume(text, { model: openai('gpt-4o-mini') });
```

Como `model` es un `LanguageModel` estándar del AI SDK, funciona con cualquier proveedor del AI SDK: `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/google`, etc. Instalá el proveedor que quieras y pasale su instancia de modelo. Pasá siempre una instancia de modelo: el AI SDK también acepta un string (`model: "openai/gpt-4o-mini"`), pero eso se resuelve a través del Vercel AI Gateway (requiere `AI_GATEWAY_API_KEY`), no con tu propio proveedor. Uses el proveedor que uses, si `warnings` contiene un aviso `responseFormat` el modelo no recibió el schema del CV y la salida será poco confiable; elegí un modelo o una configuración de proveedor con soporte de salida estructurada.

El objeto `options`:

```ts
type ParseOptions = {
  model: LanguageModel;             // cualquier instancia de modelo del AI SDK
  language?: 'auto' | 'es' | 'en';  // pista del idioma de origen, por defecto 'auto'
  instructions?: string;            // instrucciones extra que se agregan al prompt de extracción
  abortSignal?: AbortSignal;        // se reenvía a la llamada al modelo
  maxRetries?: number;              // reintentos ante errores recuperables del proveedor, por defecto 2 (el del AI SDK)
};
```

El resultado:

```ts
type ParseResult = {
  resume: Resume;      // tipado, validado contra ResumeSchema
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  warnings: string[];  // avisos del proveedor, fechas que no se pudieron normalizar, notas de confianza del modelo
};
```

### Errores

`parseResume` lanza un `CvparseError` ante cualquier fallo, con el error original como `cause`:

```ts
import { CvparseError, parseResume } from 'cvparse';

try {
  const { resume } = await parseResume(text, { model });
} catch (error) {
  if (CvparseError.is(error)) {
    console.error(error.code, error.message); // p. ej. PROVIDER_ERROR Extraction failed: ECONNREFUSED
  } else {
    throw error;
  }
}
```

| `code` | Cuándo |
| --- | --- |
| `INVALID_INPUT` | El texto está vacío o no es un string, o falta `options.model` |
| `NO_OBJECT_GENERATED` | El modelo no devolvió un objeto válido (`rawText` contiene lo que sí devolvió) |
| `PROVIDER_ERROR` | Falló la llamada al proveedor: conexión rechazada, autenticación, rate limit, abort (`statusCode` cuando está disponible) |
| `VALIDATION_ERROR` | El resultado normalizado no pasó `ResumeSchema` |

## Por qué cvparse

- **No existe una librería TypeScript mantenida para extracción de CVs con LLM.** Los proyectos TypeScript que hay son parsers por reglas para el navegador (open-resume y sus forks), aplicaciones completas, o paquetes de regex abandonados en 2022. Los parsers con LLM existen en Python, en su mayoría como scripts. cvparse es una librería: sin UI, sin framework, solo una función y un CLI.
- **Los CVs en español son un objetivo de primera clase.** Los formatos de fecha en español ("marzo 2021 – actualidad") y las convenciones de ubicación de LATAM (CABA, Argentina; Medellín, Antioquia) ya se ejercitan en los fixtures de prueba. La normalización de títulos de España ("Grado", "Máster") está en la hoja de ruta de 0.1, y los CVs con idiomas mezclados forman parte del dataset de evaluación de 0.3.
- **Normalización de fechas determinística.** Después de la llamada al modelo, cvparse normaliza las fechas por su cuenta: nombres y abreviaturas de meses en español, inglés y portugués, marcadores de vigencia ("actualidad", "presente", "a la fecha", "current"), fechas numéricas con el día primero (`03/2021`, `15/03/2021`) y años sueltos se convierten en `YYYY`, `YYYY-MM` o `YYYY-MM-DD`, y cada fecha que no puede normalizar se reporta en `warnings` en vez de pasar en silencio. `normalizeDate` se exporta por si lo querés usar solo.
- **Salida tipada.** El resultado se valida con Zod y obtenés un tipo `Resume`. Sin `any`, sin parsear JSON a mano después.
- **Multi-proveedor.** Traé cualquier modelo que soporte el Vercel AI SDK. Cambiá Ollama por OpenAI, Anthropic, Bedrock o Google modificando una línea.
- **Local primero.** Los CVs son datos personales. La configuración por defecto del CLI corre contra Ollama en localhost y no envía nada a terceros. La librería nunca se conecta a ningún servicio propio.

## Schema de salida

La salida sigue los nombres de campo y la forma de [JSON Resume](https://jsonresume.org/schema/) v1, así que funciona con el ecosistema existente de temas, builders y CLIs:

`basics`, `work`, `volunteer`, `education`, `awards`, `certificates`, `publications`, `skills`, `languages`, `interests`, `references`, `projects`.

Todos los campos son opcionales y toleran `null`, porque los CVs reales están incompletos. Las fechas son strings ISO con la precisión que da el CV: `YYYY`, `YYYY-MM` o `YYYY-MM-DD`.

cvparse agrega sus propios datos bajo la clave `x_cvparse` para que la parte JSON Resume quede limpia:

- `detectedLanguage` — código ISO 639-1 del idioma en el que está escrito el CV (`es`, `en`, `pt`, ...).
- `normalizedSkills` — lista plana y sin duplicados de habilidades como nombres canónicos en minúsculas.
- `location` — ubicación estructurada pensada para LATAM: `countryCode` (ISO 3166-1 alpha-2), `adminRegion` (estado, provincia, departamento, comunidad autónoma), `city`, y `raw` (la ubicación tal cual aparece en el CV).
- `confidenceNotes` — notas breves sobre extracciones ambiguas o inciertas; también se agregan a `warnings`.

Los schemas Zod (`ResumeSchema`, `BasicsSchema`, `WorkSchema`, `EducationSchema`, `SkillSchema`, `ExtensionSchema` y el resto) se exportan para que puedas validar, extender o reutilizarlos. La definición autoritativa está en [`src/schema/resume.ts`](./src/schema/resume.ts).

```ts
import { ResumeSchema, type Resume } from 'cvparse';

const parsed: Resume = ResumeSchema.parse(JSON.parse(raw));
```

### Ejemplo: un CV en español

Entrada (sintética, abreviada):

```text
María Fernández López
Desarrolladora Backend · Córdoba, Argentina
maria.fernandez@example.com · +54 351 555 0134

Experiencia
Backend Developer — Fintech Andina · Córdoba · marzo 2021 – actualidad
  APIs en Node.js y NestJS, PostgreSQL, despliegue en AWS.
Desarrolladora Junior — Soluciones Web SRL · 2019 – 2021

Educación
Licenciatura en Ciencias de la Computación — Universidad Nacional de Córdoba, 2014 – 2019

Idiomas: Español (nativo), Inglés (B2)
Habilidades: TypeScript, Node.js, NestJS, PostgreSQL, Docker, AWS
```

Salida:

```json
{
  "basics": {
    "name": "María Fernández López",
    "label": "Desarrolladora Backend",
    "email": "maria.fernandez@example.com",
    "phone": "+54 351 555 0134",
    "location": { "city": "Córdoba", "countryCode": "AR" }
  },
  "work": [
    {
      "name": "Fintech Andina",
      "position": "Backend Developer",
      "location": "Córdoba",
      "startDate": "2021-03",
      "endDate": null,
      "summary": "APIs en Node.js y NestJS, PostgreSQL, despliegue en AWS."
    },
    {
      "name": "Soluciones Web SRL",
      "position": "Desarrolladora Junior",
      "startDate": "2019",
      "endDate": "2021"
    }
  ],
  "education": [
    {
      "institution": "Universidad Nacional de Córdoba",
      "studyType": "Licenciatura",
      "area": "Ciencias de la Computación",
      "startDate": "2014",
      "endDate": "2019"
    }
  ],
  "skills": [
    { "name": "TypeScript" }, { "name": "Node.js" }, { "name": "NestJS" },
    { "name": "PostgreSQL" }, { "name": "Docker" }, { "name": "AWS" }
  ],
  "languages": [
    { "language": "Español", "fluency": "Nativo" },
    { "language": "Inglés", "fluency": "B2" }
  ],
  "x_cvparse": {
    "detectedLanguage": "es",
    "normalizedSkills": ["typescript", "node.js", "nestjs", "postgresql", "docker", "aws"],
    "location": { "countryCode": "AR", "adminRegion": "Córdoba", "city": "Córdoba", "raw": "Córdoba, Argentina" },
    "confidenceNotes": ["'actualidad' interpretado como puesto vigente (endDate: null)."]
  }
}
```

Los valores exactos dependen del modelo que uses. Los modelos locales pequeños serán menos consistentes que los modelos de frontera; ese compromiso lo decidís vos.

## Cuándo NO usar esto

| Si necesitás... | Usá en su lugar |
| --- | --- |
| Parsear sin LLM (determinístico, offline, sin ningún modelo) | Un parser por reglas como el de [open-resume](https://github.com/xitanggg/open-resume). Esperá menor precisión en layouts no estándar. |
| Algo que corra en el navegador | cvparse apunta a Node >= 22. Existen parsers por reglas para el navegador; las llamadas a LLM desde el navegador exponen tus API keys. |
| Parsing comercial de alto volumen con SLAs, taxonomías y contratos de soporte | Affinda, Textkernel, RChilli, Daxtra, HireAbility. Están por delante en volumen, cobertura de taxonomías y casos borde, y cobran en consecuencia. |
| Entrada PDF, DOCX o imagen escaneada **hoy** | Todavía no: 0.0.1 es solo texto plano. Extraé el texto vos (p. ej. `pdf-parse`, `mammoth`, Textract) y pasalo, o esperá a 0.1 / 0.2. |
| Salida garantizada y reproducible para la misma entrada | La salida de un LLM varía entre ejecuciones y modelos. cvparse valida la forma, no la semántica. Fijá un modelo y una temperatura y evaluá con tus propios datos. |
| Matching, ranking o scoring de CV contra ofertas | cvparse solo extrae. Combinalo con un matcher como Resume-Matcher. |
| Python | Existen varios parsers de CV con LLM para Python. cvparse es solo TypeScript. |

## Hoja de ruta

Resumen; el plan completo está en [docs/ROADMAP.md](./docs/ROADMAP.md).

- **0.1** — Extracción de texto de PDF (incluidos layouts a dos columnas) y entrada DOCX. `npx cvparse ./cv.pdf` funciona directamente.
- **0.2** — Adaptador de OCR para CVs escaneados e imágenes (intercambiable: Tesseract, AWS Textract).
- **0.3** — Dataset de evaluación público de CVs sintéticos en español con layouts difíciles, y un benchmark publicado contra open-resume.
- **Más adelante** — Empaquetado como agent skill y servidor MCP para usar cvparse directamente desde agentes de código y asistentes.

## Contribuir

Los issues y pull requests son bienvenidos. Leé primero [CONTRIBUTING.md](./CONTRIBUTING.md), en particular las reglas para los CVs de prueba: solo datos sintéticos, nunca el CV de una persona real. Se espera que todos los participantes sigan el [Código de Conducta](./CODE_OF_CONDUCT.md).

## Seguridad

Los CVs son datos personales. cvparse envía el texto únicamente al proveedor de modelo que configurás y a ningún otro lado. Para reportar una vulnerabilidad, ver [SECURITY.md](./SECURITY.md).

## Licencia

[MIT](./LICENSE) © 2026 Nikire

## Acerca de

cvparse está construido y mantenido por el fundador de Borderless ATS, donde parsear CVs en español de forma confiable es un problema diario y no una demo.
