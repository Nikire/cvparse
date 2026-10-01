# cvparse

Convierte CVs y currículums en JSON tipado y compatible con JSON Resume usando LLMs, con cualquier proveedor que soporte el Vercel AI SDK, incluidos modelos locales vía Ollama.

[![npm version](https://img.shields.io/npm/v/%40cvparse%2Fcore.svg)](https://www.npmjs.com/package/@cvparse/core)
[![CI](https://img.shields.io/github/actions/workflow/status/Nikire/cvparse/ci.yml?branch=main&label=CI)](https://github.com/Nikire/cvparse/actions)
[![License: MIT](https://img.shields.io/github/license/Nikire/cvparse.svg)](https://github.com/Nikire/cvparse/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/node/v/%40cvparse%2Fcore.svg)](https://nodejs.org)

> **Estado: 0.x — etapa temprana.**
> cvparse lee **PDF, DOCX y texto plano**. Los PDF se leen en orden de lectura, incluidos los layouts a dos columnas y con barra lateral. Los PDF escaneados y las imágenes necesitan OCR, que llega como adaptador en 0.2. Ver la [hoja de ruta](#hoja-de-ruta). El schema y la API todavía pueden cambiar antes de 1.0.

[English version](./README.md)

## Inicio rápido

### CLI, en local con Ollama

Requiere Node >= 22 y [Ollama](https://ollama.com) corriendo en tu máquina.

```bash
ollama pull llama3.1
npx @cvparse/core ./cv.pdf --pretty
```

El paquete npm es `@cvparse/core`; el comando que instala es `cvparse` (`npm i -g @cvparse/core` y después `cvparse ./cv.pdf`).

`cvparse` usa por defecto Ollama en `http://localhost:11434/v1`. Nada sale de tu máquina.

La entrada puede ser un PDF, un DOCX o un archivo de texto plano; el formato se detecta por el contenido del archivo, no por la extensión. Para un PDF o DOCX el CLI imprime una línea `info:` por stderr con lo que leyó, p. ej. `info: read pdf, 2 page(s), multi-column layout`.

Otros proveedores:

```bash
# OpenAI (lee OPENAI_API_KEY del entorno si se omite --api-key)
npx @cvparse/core ./cv.docx --provider openai --model gpt-4o-mini --pretty

# Cualquier endpoint compatible con OpenAI (LM Studio, vLLM, Groq, OpenRouter, ...)
npx @cvparse/core ./cv.txt --provider openai-compatible --base-url http://localhost:1234/v1 --model mi-modelo
```

Todos los flags:

| Flag | Valores | Notas |
| --- | --- | --- |
| `<file>` | ruta o `-` | Ruta al CV: `.pdf`, `.docx` o texto plano (`.txt`, `.md`, ...). El formato se detecta por el contenido del archivo. `-` lee de stdin, como texto o como bytes. Los PDF escaneados y las imágenes necesitan OCR, previsto para 0.2 (salida 2) |
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
| `1` | Falló la extracción (error del proveedor, salida del modelo inválida, documento corrupto) |
| `2` | Error de uso (argumentos incorrectos, archivo inexistente, entrada no soportada o vacía, PDF sin capa de texto) |

Así se puede encadenar con pipes y scripts:

```bash
npx @cvparse/core ./cv.pdf | jq '.basics.name'
cat cv.pdf | npx @cvparse/core - --lang es
```

### Programático

```bash
npm install @cvparse/core @ai-sdk/openai-compatible
```

`parseResume` recibe el CV, como string o como los bytes de un archivo PDF, DOCX o de texto, más cualquier modelo de lenguaje del AI SDK. Con Ollama todo corre en local:

```ts
import { readFile } from 'node:fs/promises';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { parseResume } from '@cvparse/core';

const ollama = createOpenAICompatible({
  name: 'ollama',
  baseURL: 'http://localhost:11434/v1',
  // Obligatorio: sin esto el proveedor manda `json_object` en vez del schema del CV
  // y `warnings` incluye un aviso `responseFormat`. Ollama >= 0.5, OpenAI, LM Studio
  // y vLLM lo soportan.
  supportsStructuredOutputs: true,
});

// Un Buffer de Node es un Uint8Array, así que los bytes del archivo se pasan tal cual.
// El formato (PDF, DOCX, texto) se detecta a partir de los bytes.
const buffer = await readFile('./cv.pdf');

const { resume, source, usage, warnings } = await parseResume(buffer, {
  model: ollama('llama3.1'),
  language: 'auto', // 'es' | 'en' | 'auto'
});

console.log(source); // { format: 'pdf', pages: 2, layout: 'multi-column' }
console.log(resume.basics?.name);
console.log(resume.work?.[0]?.position);
```

Un string se toma como el texto del CV. Para pasar un nombre de archivo que desempate la detección, o para saltearla, envolvé los bytes: `parseResume({ data: buffer, filename: 'cv.docx' }, { model })` o `parseResume({ data, format: 'pdf' }, { model })`.

O con OpenAI, a través del mismo paquete de proveedor:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { parseResume } from '@cvparse/core';

const openai = createOpenAICompatible({
  name: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  supportsStructuredOutputs: true,
});

const { resume } = await parseResume(buffer, { model: openai('gpt-4o-mini') });
```

Si solo querés el texto, `extractText` es el mismo paso de extracción sin la llamada al modelo. Sirve para ver qué va a recibir el modelo o para alimentar tu propio pipeline:

```ts
import { readFile } from 'node:fs/promises';
import { detectFormat, extractText } from '@cvparse/core';

const data = await readFile('./cv.pdf');
detectFormat(data); // 'pdf' | 'docx' | 'text' | 'image' | 'legacy-doc' | 'zip' | 'unknown'

const { text, format, pages, layout, warnings } = await extractText(data);
```

El soporte de PDF y DOCX se carga bajo demanda (pdf.js vía `unpdf`, y `mammoth`), así que pasar un string nunca carga ninguno de los dos.

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
  warnings: string[];  // avisos de extracción (con prefijo `extract:`), avisos del proveedor,
                       // fechas que no se pudieron normalizar, notas de confianza del modelo
  source: {
    format: 'text' | 'pdf' | 'docx';                      // cómo se leyó la entrada
    pages?: number;                                       // solo PDF
    layout: 'single-column' | 'multi-column' | 'unknown'; // solo PDF; 'unknown' en el resto
  };
};
```

### Errores

`parseResume` lanza un `CvparseError` ante cualquier fallo, con el error original como `cause`:

```ts
import { CvparseError, parseResume } from '@cvparse/core';

try {
  const { resume } = await parseResume(buffer, { model });
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
| `INVALID_INPUT` | La entrada está vacía, no es un string / `Uint8Array` / `{ data }`, o el documento no tenía texto; o falta `options.model` |
| `UNSUPPORTED_INPUT` | Los bytes son una imagen (necesita OCR, previsto para 0.2), un `.doc` antiguo, un ZIP que no es DOCX, o no se reconocen como PDF, DOCX ni texto UTF-8 |
| `NO_TEXT_LAYER` | El PDF no tiene texto extraíble (escaneado o solo imagen). Corré OCR primero y pasá el texto |
| `EXTRACTION_FAILED` | No se pudo leer el documento: PDF corrupto o protegido con contraseña, DOCX roto |
| `NO_OBJECT_GENERATED` | El modelo no devolvió un objeto válido (`rawText` contiene lo que sí devolvió) |
| `PROVIDER_ERROR` | Falló la llamada al proveedor: conexión rechazada, autenticación, rate limit, abort (`statusCode` cuando está disponible) |
| `VALIDATION_ERROR` | El resultado normalizado no pasó `ResumeSchema` |

## Por qué cvparse

- **No existe una librería TypeScript mantenida para extracción de CVs con LLM.** Los proyectos TypeScript que hay son parsers por reglas para el navegador (open-resume y sus forks), aplicaciones completas, o paquetes de regex abandonados en 2022. Los parsers con LLM existen en Python, en su mayoría como scripts. cvparse es una librería: sin UI, sin framework, solo una función y un CLI.
- **Los PDF a dos columnas salen en orden de lectura.** cvparse reconstruye el orden de lectura a partir de la posición del texto en la página (un XY-cut recursivo): detecta la canaleta vertical de los layouts a dos columnas y con barra lateral, deja en su lugar los encabezados y pies a ancho completo, y después corta por los huecos verticales, así que la columna izquierda se lee antes que la derecha en vez de intercalarse línea por línea. Límites conocidos: tres o más columnas solo se resuelven de forma incidental, las tablas pueden leerse fila por fila, el texto rotado o de derecha a izquierda se ignora, y un bloque corto de fechas alineadas a la derecha puede a veces leerse como segunda columna. Los DOCX pasan por `mammoth`, con las tablas de maquetación leídas celda por celda y los cuadros de texto recuperados; los encabezados y pies de página del DOCX no se leen.
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
import { ResumeSchema, type Resume } from '@cvparse/core';

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
| PDF escaneados o imágenes como entrada **hoy** | Todavía no: un PDF sin capa de texto falla con `NO_TEXT_LAYER` y las imágenes se rechazan. Corré OCR vos (Tesseract, Textract) y pasá el texto, o esperá al adaptador de OCR de 0.2. Los `.doc` antiguos también se rechazan: guardalos como `.docx` o PDF. |
| Salida garantizada y reproducible para la misma entrada | La salida de un LLM varía entre ejecuciones y modelos. cvparse valida la forma, no la semántica. Fijá un modelo y una temperatura y evaluá con tus propios datos. |
| Matching, ranking o scoring de CV contra ofertas | cvparse solo extrae. Combinalo con un matcher como Resume-Matcher. |
| Python | Existen varios parsers de CV con LLM para Python. cvparse es solo TypeScript. |

## Hoja de ruta

Resumen; el plan completo está en [docs/ROADMAP.md](./docs/ROADMAP.md).

- **0.1** (hecho) — Extracción de texto de PDF con reconstrucción del orden de lectura para layouts a dos columnas y con barra lateral, entrada DOCX incluidas tablas y cuadros de texto, detección de formato por bytes, `extractText` / `detectFormat`. `npx @cvparse/core ./cv.pdf` funciona directamente. Pendiente dentro de 0.1: más formas de fecha, normalización de títulos para España y LATAM, pasaje de `temperature`.
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
