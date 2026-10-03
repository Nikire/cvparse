# cvparse

Convierte CVs y currículums en JSON tipado y compatible con JSON Resume usando LLMs, con cualquier proveedor que soporte el Vercel AI SDK, incluidos modelos locales vía Ollama.

[![npm version](https://img.shields.io/npm/v/%40cvparse%2Fcore.svg)](https://www.npmjs.com/package/@cvparse/core)
[![CI](https://img.shields.io/github/actions/workflow/status/Nikire/cvparse/ci.yml?branch=main&label=CI)](https://github.com/Nikire/cvparse/actions)
[![License: MIT](https://img.shields.io/github/license/Nikire/cvparse.svg)](https://github.com/Nikire/cvparse/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/node/v/%40cvparse%2Fcore.svg)](https://nodejs.org)

> **Estado: 0.x — etapa temprana.**
> cvparse lee **PDF, DOCX y texto plano**. Los PDF se leen en orden de lectura, incluidos los layouts a dos columnas y con barra lateral. Las **imágenes (PNG, JPEG, WebP, TIFF) y los PDF escaneados** se leen con un adaptador de OCR (Tesseract en local, o AWS Textract) o en modo visión (las imágenes de las páginas van a un modelo multimodal); ver [CVs escaneados e imágenes](#cvs-escaneados-e-imágenes). Ver la [hoja de ruta](#hoja-de-ruta). El schema y la API todavía pueden cambiar antes de 1.0.

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

**Subí la ventana de contexto de Ollama.** Ollama sirve todos los modelos con una ventana de contexto fijada en el servidor (4096 tokens en muchas instalaciones), sin importar lo que soporte el modelo. Un CV largo más el JSON extraído puede superarla, y entonces Ollama descarta en silencio el principio de la conversación, instrucciones incluidas, y se pierden entradas. Definí `OLLAMA_CONTEXT_LENGTH=16384` en el entorno del servidor de Ollama y reinicialo:

```bash
# Windows (después cerrá y volvé a abrir Ollama desde la bandeja)
setx OLLAMA_CONTEXT_LENGTH 16384
# macOS (app de Ollama; después reiniciala)
launchctl setenv OLLAMA_CONTEXT_LENGTH 16384
# Linux (systemd): agregá Environment="OLLAMA_CONTEXT_LENGTH=16384" bajo [Service]
sudo systemctl edit ollama && sudo systemctl restart ollama
```

Después de cada llamada a Ollama el CLI le pregunta al servidor la ventana de contexto cargada e imprime un `warning:` con esta pista cuando la llamada usó el 90 % o más.

La entrada puede ser un PDF, un DOCX, un archivo de texto plano o, con `--ocr`, una imagen o un PDF escaneado; el formato se detecta por el contenido del archivo, no por la extensión. Para un PDF o DOCX el CLI imprime una línea `info:` por stderr con lo que leyó, p. ej. `info: read pdf, 2 page(s), multi-column layout`.

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
| `<file>` | ruta o `-` | Ruta al CV: `.pdf`, `.docx`, `.png` / `.jpg` / `.webp` / `.tiff` o texto plano (`.txt`, `.md`, ...). El formato se detecta por el contenido del archivo. `-` lee de stdin, como texto o como bytes. Las imágenes y los PDF escaneados necesitan `--ocr`; sin él, el CLI sale con código 2 y una pista |
| `--provider` | `ollama` \| `openai` \| `openai-compatible` | Por defecto: `ollama` |
| `--model <id>` | cualquier id de modelo que conozca el proveedor | Por defecto: `llama3.1` (ollama), `gpt-4o-mini` (openai); obligatorio para `openai-compatible` |
| `--base-url <url>` | URL | Por defecto: `http://localhost:11434/v1` (ollama), `https://api.openai.com/v1` (openai); obligatorio para `openai-compatible` |
| `--api-key <key>` | string | Se envía como Bearer token. Si se omite, usa la variable de entorno `CVPARSE_API_KEY` (cualquier proveedor) u `OPENAI_API_KEY` (solo con `--provider openai`). La clave solo se envía a la base URL configurada: `https://api.openai.com/v1` por defecto con `--provider openai`; si sobrescribís `--base-url`, la clave se manda a ese host |
| `--lang` | `es` \| `en` \| `auto` | Pista del idioma del CV. Por defecto: `auto` |
| `--pretty` | flag | Indenta la salida JSON |
| `--ocr <engine>` | `tesseract` \| `textract` \| `vision` | Cómo leer imágenes y PDF escaneados. `tesseract`: local (`npm i tesseract.js`). `textract`: AWS (`npm i @aws-sdk/client-textract`; usa la cadena de credenciales por defecto de AWS y `AWS_REGION`). `vision`: manda las imágenes de las páginas al modelo, que tiene que aceptar imágenes (p. ej. `gemma3:4b`, `gpt-4o-mini`). Los PDF escaneados se renderizan con `@napi-rs/canvas` (`npm i @napi-rs/canvas`). Ver [CVs escaneados e imágenes](#cvs-escaneados-e-imágenes) |
| `--ocr-lang <codes>` | códigos ISO separados por coma, p. ej. `es,en` | Pistas de idioma para el OCR. Por defecto: `--lang` si se indicó, si no `es,en` |
| `--extract-only` | flag | Imprime el texto extraído del documento en orden de lectura y termina, sin llamar a ningún modelo. Sirve para ver cómo se leyó un PDF a dos columnas o para adjuntar el texto a un reporte de bug. No necesita proveedor ni clave. Funciona con `--ocr tesseract` / `textract`, no con `--ocr vision` |
| `-h`, `--help` | flag | Imprime la ayuda por stderr |
| `-v`, `--version` | flag | Imprime la versión de cvparse |

El CLI imprime únicamente el objeto `resume` como JSON por **stdout**; los `warnings` van por **stderr** como líneas `warning:`, junto con la ayuda y los errores. Códigos de salida:

| Código | Significado |
| --- | --- |
| `0` | Éxito |
| `1` | Falló la extracción (error del proveedor, salida del modelo inválida, documento corrupto, error del motor o la API de OCR) |
| `2` | Error de uso (argumentos incorrectos, archivo inexistente, entrada no soportada o vacía, imagen o PDF escaneado sin `--ocr`, paquete de OCR no instalado) |

Así se puede encadenar con pipes y scripts:

```bash
npx @cvparse/core ./cv.pdf | jq '.basics.name'
cat cv.pdf | npx @cvparse/core - --lang es
```

### Programático

```bash
npm install @cvparse/core @ai-sdk/openai-compatible
```

`parseResume` recibe el CV, como string o como los bytes de un archivo PDF, DOCX o de texto (o de una imagen o un PDF escaneado, con la opción `ocr`; ver [CVs escaneados e imágenes](#cvs-escaneados-e-imágenes)), más cualquier modelo de lenguaje del AI SDK. Con Ollama todo corre en local:

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
  temperature?: number;             // temperatura de muestreo; omitila para el default del proveedor, 0 va bien para copiar
  referenceDate?: Date;             // "hoy" para fechas relativas ("hace 3 años"); por defecto new Date()
  grounding?: boolean;              // contrasta la salida con el texto del documento; por defecto true (ver más abajo)
  ocr?: OcrAdapter | 'vision';      // cómo leer imágenes y PDF escaneados; sin esto fallan con OCR_REQUIRED / NO_TEXT_LAYER
  ocrLanguages?: readonly string[]; // pistas de idioma para el OCR (ISO 639-1, p. ej. ['es', 'en']); por defecto `language` si se indicó
};
```

El resultado:

```ts
type ParseResult = {
  resume: Resume;      // tipado, validado contra ResumeSchema
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  warnings: string[];  // legibles, uno por línea; ver "Avisos" más abajo
  source: {
    format: 'text' | 'pdf' | 'docx' | 'image';            // cómo se leyó la entrada
    pages?: number;                                       // PDF (y modo visión)
    layout: 'single-column' | 'multi-column' | 'unknown'; // PDF e imágenes con OCR; 'unknown' en el resto
    ocr?: {                                               // solo si el texto vino de OCR o del modo visión
      adapter: string;                                    // 'tesseract', 'textract', el nombre de tu adaptador, o 'vision'
      confidence?: number;                                // promedio 0..1, si el motor lo reporta (no en modo visión)
      pages: number;                                      // páginas (imágenes) reconocidas
    };
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
| `UNSUPPORTED_INPUT` | Un `.doc` antiguo, un ZIP que no es DOCX, un formato de imagen que ningún camino de OCR acepta (GIF, BMP), o bytes que no se reconocen como PDF, DOCX, imagen ni texto UTF-8 |
| `OCR_REQUIRED` | La entrada es una imagen y no se configuró la opción `ocr`. Pasá un adaptador de OCR u `ocr: 'vision'`. Código de salida 2 en el CLI |
| `NO_TEXT_LAYER` | El PDF no tiene texto extraíble (escaneado o solo imagen) y no se configuró la opción `ocr`. Se resuelve igual que `OCR_REQUIRED`. Código de salida 2 en el CLI |
| `OCR_FAILED` | Falló el adaptador de OCR: error del motor, error de la API de Textract (acceso denegado, throttling, documento inválido), imagen no soportada por ese motor. `statusCode` si vino de una API HTTP. Código de salida 1 en el CLI |
| `MISSING_DEPENDENCY` | Falta una dependencia peer opcional: `tesseract.js`, `@aws-sdk/client-textract`, o `@napi-rs/canvas` (necesaria para renderizar PDF escaneados). El mensaje incluye el comando `npm install`. Código de salida 2 en el CLI |
| `EXTRACTION_FAILED` | No se pudo leer el documento: PDF corrupto o protegido con contraseña, DOCX roto |
| `NO_OBJECT_GENERATED` | El modelo no devolvió un objeto válido (`rawText` contiene lo que sí devolvió) |
| `PROVIDER_ERROR` | Falló la llamada al proveedor: conexión rechazada, autenticación, rate limit, abort (`statusCode` cuando está disponible) |
| `VALIDATION_ERROR` | El resultado normalizado no pasó `ResumeSchema` |

### Avisos

Los problemas que no frenan el parseo van a `ParseResult.warnings` (y en el CLI, por stderr como líneas `warning:`). Los avisos están en inglés y la mayoría empieza con un prefijo por el que se puede filtrar:

| Prefijo | Significado |
| --- | --- |
| `extract:` | Lectura del documento: páginas escaneadas sin OCR, cajas de texto de DOCX, fallbacks y problemas de OCR (`extract: ocr: low confidence ...`) |
| `grounding:` | Un valor que no está en el documento se descartó o se reemplazó por lo que está escrito |
| `placement:` | Una entrada se movió a la sección bajo cuyo título está escrita |
| `coverage:` | El documento tiene una sección (p. ej. "Proyectos") que volvió vacía |
| `precision:` | Una fecha a la que el modelo le inventó mes o día se recortó a lo que dice el CV |
| `model:` | Las notas de confianza del propio modelo (`x_cvparse.confidenceNotes`) |

Los avisos del proveedor (como `responseFormat`), las fechas que no se pudieron normalizar y las reparaciones menores (organización y título separados, varias fechas de un premio reducidas a la última) van sin prefijo.

### Cómo evita cvparse que el modelo invente

Los LLM, sobre todo los locales chicos, rellenan huecos con invenciones verosímiles. Probando un CV real de 3 páginas con un modelo de 8B aparecieron un teléfono, una ciudad y tres habilidades que no estaban en el documento. Por eso, después de la llamada al modelo, cvparse contrasta la salida con el texto que leyó, de forma determinística:

- **Grounding.** Los datos de contacto (email, teléfono, URLs, perfiles), las ubicaciones (la del candidato y la de cada entrada, incluida la ciudad del candidato copiada en todos los trabajos), las habilidades y sus niveles, y los idiomas se buscan en el documento (sin distinguir tildes ni mayúsculas). Lo que no está se descarta. El nivel de idioma y los títulos de estudios y puestos que el modelo reescribió se reemplazan por lo que está escrito junto al idioma, la institución o la empresa. Cada cambio agrega un aviso `grounding:`. Los resúmenes, logros, nombres de empresas y fechas no se contrastan. Con `grounding: false` se conserva la salida cruda del modelo. En modo visión no se aplica, porque no hay texto contra el cual comparar.
- **Ubicación en secciones.** Una entrada que el modelo puso en la sección equivocada (una universidad en `work[]`, un trabajo en `education[]`, un curso en `work[]`) se mueve a la sección bajo cuyo título está escrita, con un aviso `placement:`.
- **Cobertura.** Si el documento tiene un título de sección (o una etiqueta en línea tipo "Idiomas:") y el array correspondiente volvió vacío, un aviso `coverage:` lo indica: suele ser un modelo que cortó antes de tiempo.
- **Sin meses inventados.** "2020" convertido en "2020-01" vuelve a "2020" cuando el CV nunca escribe un mes para ese año (aviso `precision:`).
- **Lista de habilidades determinística.** `x_cvparse.normalizedSkills` lo calcula cvparse a partir de `skills`; nunca se toma del modelo.

`groundResume` y `checkCoverage` se exportan por si querés aplicarlos a la salida de tu propio pipeline.

## CVs escaneados e imágenes

Una foto, un escaneo o un PDF sin capa de texto no tiene texto para leer. cvparse los resuelve de una de tres formas, que se eligen con `ParseOptions.ocr` (o `--ocr` en el CLI). La guía completa, con todas las opciones de los adaptadores, uso offline, consejos de calidad y cómo escribir tu propio adaptador, está en [docs/ocr.md](./docs/ocr.md) (en inglés).

| | Tesseract | AWS Textract | Modo visión |
| --- | --- | --- | --- |
| Opción | `ocr: createTesseractAdapter()` | `ocr: createTextractAdapter()` | `ocr: 'vision'` |
| Corre | En local (WASM, en un worker thread) | En AWS, se paga por página | Donde corra tu `model` |
| Modelo | Cualquier modelo de texto | Cualquier modelo de texto | Tiene que aceptar imágenes (`gemma3:4b`, `qwen2.5vl`, `gpt-4o-mini`, ...) |
| Instalación | `npm install tesseract.js` | `npm install @aws-sdk/client-textract` | nada extra |

Los motores de OCR son **dependencias peer opcionales** y se cargan solo cuando los usás; si falta uno, recibís `MISSING_DEPENDENCY` con el comando de instalación. Los PDF escaneados se renderizan primero a PNG, para lo que hace falta otra peer opcional, `@napi-rs/canvas`, en cualquiera de los tres modos. Los adaptadores de OCR reciben como máximo 20 páginas renderizadas, y el modo visión manda como máximo 5 imágenes de página al modelo; un warning avisa cuando un documento quedó cortado. Instalá los paquetes en el mismo proyecto que cvparse; `npx @cvparse/core` usa entonces esa instalación local.

### Tesseract (local)

```bash
npm install tesseract.js @napi-rs/canvas   # @napi-rs/canvas solo hace falta para PDF escaneados
```

```ts
import { readFile } from 'node:fs/promises';
import { parseResume } from '@cvparse/core';
import { createTesseractAdapter } from '@cvparse/core/ocr/tesseract';

const ocr = createTesseractAdapter({ languages: ['es', 'en'] });
try {
  const { resume, source } = await parseResume(await readFile('./scan.jpg'), { model, ocr });
  console.log(source.ocr); // { adapter: 'tesseract', confidence: 0.91, pages: 1 }
} finally {
  await ocr.dispose?.(); // el worker thread mantiene vivo el proceso hasta que se libera
}
```

```bash
npx @cvparse/core ./scan.jpg --ocr tesseract --ocr-lang es
```

Tesseract lee bien el texto impreso, y como las palabras con posición pasan por la misma detección de columnas que los PDF, los escaneos a dos columnas salen en orden de lectura. Con el escaneo sintético a dos columnas de `test/fixtures/pdf/scanned-es.pdf` tarda unos 2 segundos en la CPU de una notebook, con un solo error de OCR (una `@` leída como `Q`). Reutilizá un mismo adaptador para un lote de CVs. `source.ocr.confidence` es la confianza promedio por palabra, y cvparse agrega un warning para las páginas por debajo de 0.7, así podés derivar los resultados dudosos a una persona.

### AWS Textract (en la nube)

```bash
npm install @aws-sdk/client-textract @napi-rs/canvas   # @napi-rs/canvas solo hace falta para PDF escaneados
```

```ts
import { createTextractAdapter } from '@cvparse/core/ocr/textract';

const ocr = createTextractAdapter({ region: 'us-east-1' }); // features: 'detect' (por defecto) o 'layout'
const { resume } = await parseResume(await readFile('./scan.png'), { model, ocr });
await ocr.dispose?.();
```

```bash
npx @cvparse/core ./scan.pdf --ocr textract
```

Las credenciales y la región salen de la cadena estándar del AWS SDK (`AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, SSO, roles de instancia; `AWS_REGION`). `features: 'layout'` usa el modelo de layout de Textract para el orden de lectura y cuesta más por página; ver [docs/ocr.md](./docs/ocr.md#detect-vs-layout). Textract acepta JPEG, PNG y TIFF de hasta 10 MB, no WebP.

### Modo visión

Sin motor de OCR: las imágenes de las páginas van directo al modelo, que las lee por su cuenta. El modelo tiene que aceptar imágenes.

```ts
const { resume, source } = await parseResume(await readFile('./scan.png'), {
  model: ollama('gemma3:4b'),
  ocr: 'vision',
});
```

```bash
npx @cvparse/core ./scan.pdf --ocr vision --model gemma3:4b
npx @cvparse/core ./photo.jpg --ocr vision --provider openai --model gpt-4o-mini
```

En local, `gemma3:4b` leyó bien nombre, puestos, fechas, habilidades e idiomas del PNG sintético de los fixtures en unos 13 segundos; `qwen2.5vl` es otra opción. `llama3.2-vision` no carga en las versiones actuales de Ollama (arquitectura desconocida `mllama`). En la nube, `gpt-4o-mini` es una opción barata. El modo visión acepta imágenes PNG, JPEG y WebP, y PDF escaneados (renderizados con `@napi-rs/canvas`).

### Privacidad

- **Tesseract** corre en tu máquina y nunca manda la imagen a ningún lado. La primera vez que usa un idioma descarga el archivo `traineddata` (unos pocos MB) desde el CDN de jsDelivr, lo que necesita red y le dice al CDN qué idiomas usás. Configurá `langPath` / `cachePath` para servir o precargar esos archivos y trabajar offline ([detalles](./docs/ocr.md#traineddata-and-offline-use)). Con Tesseract y Ollama, nada sale de tu máquina.
- **Textract** manda el CV a AWS, en la región que elijas. Revisá tu acuerdo de procesamiento de datos y el opt-out de servicios de IA de AWS antes de usarlo con candidatos reales.
- **El modo visión** manda las imágenes de las páginas al proveedor de modelo que configuraste: tu propia máquina con Ollama, los servidores del proveedor en cualquier otro caso.

## Por qué cvparse

- **No existe una librería TypeScript mantenida para extracción de CVs con LLM.** Los proyectos TypeScript que hay son parsers por reglas para el navegador (open-resume y sus forks), aplicaciones completas, o paquetes de regex abandonados en 2022. Los parsers con LLM existen en Python, en su mayoría como scripts. cvparse es una librería: sin UI, sin framework, solo una función y un CLI.
- **Los PDF a dos columnas salen en orden de lectura.** cvparse reconstruye el orden de lectura a partir de la posición del texto en la página (un XY-cut recursivo): detecta la canaleta vertical de los layouts a dos columnas y con barra lateral, deja en su lugar los encabezados y pies a ancho completo, y después corta por los huecos verticales, así que la columna izquierda se lee antes que la derecha en vez de intercalarse línea por línea. Límites conocidos: tres o más columnas solo se resuelven de forma incidental, las tablas pueden leerse fila por fila, el texto rotado o de derecha a izquierda se ignora, y un bloque corto de fechas alineadas a la derecha puede a veces leerse como segunda columna. Los DOCX pasan por `mammoth`, con las tablas de maquetación leídas celda por celda y los cuadros de texto recuperados; los encabezados y pies de página del DOCX no se leen.
- **Los CVs en español son un objetivo de primera clase.** Los formatos de fecha en español ("marzo 2021 – actualidad") y las convenciones de ubicación de LATAM (CABA, Argentina; Medellín, Antioquia) ya se ejercitan en los fixtures de prueba. Los títulos de España y LATAM ("Grado", "Máster", "Licenciatura", "Tecnicatura") se normalizan en `x_cvparse.educationLevels`, y los CVs con idiomas mezclados forman parte del dataset de evaluación de 0.3.
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
- `normalizedSkills` — lista plana, sin duplicados y en minúsculas que cvparse deriva de `skills` (todas las keywords, más el nombre de las entradas sin keywords). Solo habilidades escritas en el documento; sin traducciones ni nombres canónicos.
- `location` — ubicación estructurada pensada para LATAM: `countryCode` (ISO 3166-1 alpha-2), `adminRegion` (estado, provincia, departamento, comunidad autónoma), `city`, y `raw` (la ubicación tal cual aparece en el CV).
- `confidenceNotes` — notas breves sobre extracciones ambiguas o inciertas; también se agregan a `warnings`.
- `educationLevels` — una entrada por cada ítem de `education[]`, en el mismo orden: `level` (`secondary`, `technical`, `bachelor`, `postgraduate`, `master`, `doctorate`, `course` o `unknown`), el `original` y una familia de título `canonical` ("Licenciatura", "Grado", "Ingeniería", "Tecnicatura", "Máster", "Doctorado", "Diplomado", ...). Lo calcula cvparse a partir de nombres de títulos en español, portugués e inglés; `education[].studyType` conserva el título tal como está escrito en el CV (p. ej. "Ingeniería en Sistemas", no un "Grado" inventado).

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

## Benchmark

F1 por campo sobre un dataset sintético de CVs en español con diseños difíciles (dos columnas, barras laterales, tablas y cuadros de texto en DOCX, escaneados), comparado con parsers por reglas. El harness está en [eval/](eval/).

<!-- eval:results:start -->

**Antes de leer la tabla.** El dataset y el evaluador los escribieron los autores de cvparse, así que es un benchmark dentro de distribución, no independiente: los formatos de fecha y el vocabulario de títulos son los que los normalizadores de cvparse ya contemplan. Los dos baselines detectan secciones por encabezados en inglés y estos CVs los tienen en español; esa es la brecha que el benchmark quiere mostrar, pero también significa que los baselines pierden la mayoría de las secciones por diseño. resume-parser recibe el texto que extrae cvparse (su lector propio necesita poppler), así que hereda el orden de lectura de cvparse. open-resume solo lee PDF: **Cobertura** indica cuántos CVs intentó cada sistema y **Solo PDF** compara a todos sobre los mismos 40 PDF. Más detalles en la [ficha del dataset](eval/dataset/README.md#who-made-this-and-known-biases).

Dataset 1.0.0, 60 CVs sintéticos en español.

### F1 por campo (%)

| Sistema | Cobertura | Global | Solo PDF (40) | Nombre | Email | Teléfono | Ubicación | Experiencia | Fechas exp. | Educación | Fechas educ. | Habilidades | Idiomas |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cvparse + llama3.1 8B (Ollama, local) + Tesseract | 60/60 | **98.1** | 98.8 | 100.0 | 98.3 | 100.0 | 96.7 | 92.5 | 95.6 | 99.6 | 99.0 | 98.9 | 100.0 |
| open-resume (rules) | 40/60 | **17.2** | 17.2 | 17.7 | 91.9 | 43.1 | 13.3 | 0.0 | 0.0 | 0.0 | 0.0 | 5.7 | 0.0 |
| resume-parser (regex) (2 con error) | 56/60 | **16.9** | 16.1 | 5.5 | 98.2 | 52.6 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 7.1 | 5.8 |

Global es el promedio de F1 sobre los 10 campos de la tabla, calculado sobre los CVs que cada sistema intentó (los formatos que no puede leer se omiten en vez de contar como cero, y se ven en Cobertura). Reglas de puntuación: [eval/score/README.md](eval/score/README.md).

### Diagnóstico solo de cvparse: nivel educativo

| Sistema | Nivel educ. F1 | P | R | support |
| --- | ---: | ---: | ---: | ---: |
| cvparse + llama3.1 8B (Ollama, local) + Tesseract | 96.9 | 97.3 | 96.5 | 113 |

No forma parte de Global. El vocabulario de títulos del dataset se escribió junto con el normalizador de títulos de cvparse, así que no es una medida independiente; los baselines no producen niveles educativos.

### F1 global por diseño (%)

| Diseño | cvparse + llama3.1 8B (Ollama, local) + Tesseract | open-resume (rules) | resume-parser (regex) |
| --- | ---: | ---: | ---: |
| academic (4) | 100.0 | 0.0 | 16.7 |
| functional (4) | 95.4 | 14.0 | 14.0 |
| scanned (6) | 98.2 | 0.0 | 0.0 |
| sidebar (8) | 98.0 | 17.7 | 15.5 |
| single-column (17) | 97.7 | 20.7 | 18.5 |
| table (6) | 98.0 | n/a | 15.0 |
| textbox (4) | 97.5 | n/a | 21.1 |
| two-column (11) | 99.6 | 19.9 | 17.2 |

### Configuración

- **cvparse + llama3.1 8B (Ollama, local) + Tesseract**: cvparse 0.2.0; provider: ollama, model: llama3.1, ocr: tesseract, temperature: 0, language: es, referenceDate: 2026-10-01, hardware: 12th Gen Intel(R) Core(TM) i9-12900F, 30 GB RAM, win32; GPU: NVIDIA GeForce RTX 4070 SUPER, node: v22.14.0, ollamaVersion: 0.35.0, modelDigest: sha256:46e0c10c039e, tesseract.js: 7.0.0, datasetVersion: 1.0.0, datasetHash: 76c69f1bbc2c5657, cvparseCommit: 81432f5d3015159a7d4a33db03e98f96749286a0, cvparseSrcHash: 253c04ad9d9e5715; 60 CVs en 916 s
- **open-resume (rules)**: repo: github.com/xitanggg/open-resume, commit: 4f8255a2c763479837f69f1dccf2a3338730cd79, license: AGPL-3.0 (fetched at runtime, not vendored), pdfReader: Node port of read-pdf.ts on unpdf's pdf.js, dates: normalized with cvparse normalizeDate/splitDateRange, node: v22.14.0, hardware: 12th Gen Intel(R) Core(TM) i9-12900F, 30 GB RAM, win32, datasetVersion: 1.0.0, datasetHash: 76c69f1bbc2c5657; 40 CVs en 1 s
- **resume-parser (regex)**: package: resume-parser@1.1.0, license: ISC, input: plain text from cvparse extractText (its textract/pdftotext reader is bypassed), dates: not extracted (sections are raw text), node: v22.14.0, hardware: 12th Gen Intel(R) Core(TM) i9-12900F, 30 GB RAM, win32, datasetVersion: 1.0.0, datasetHash: 76c69f1bbc2c5657; 56 CVs en 12 s

Reproducir (y luego `npm run eval:report`):

- cvparse + llama3.1 8B (Ollama, local) + Tesseract: `npm run eval -- --system cvparse --provider ollama --model llama3.1 --ocr tesseract --name "cvparse + llama3.1 8B (Ollama, local) + Tesseract" --gpu "NVIDIA GeForce RTX 4070 SUPER"`
- open-resume (rules): `npm run eval -- --system open-resume`
- resume-parser (regex): `npm run eval -- --system resume-parser`

<!-- eval:results:end -->

## Cuándo NO usar esto

| Si necesitás... | Usá en su lugar |
| --- | --- |
| Parsear sin LLM (determinístico, offline, sin ningún modelo) | Un parser por reglas como el de [open-resume](https://github.com/xitanggg/open-resume). Esperá menor precisión en layouts no estándar. |
| Algo que corra en el navegador | cvparse apunta a Node >= 22. Existen parsers por reglas para el navegador; las llamadas a LLM desde el navegador exponen tus API keys. |
| Parsing comercial de alto volumen con SLAs, taxonomías y contratos de soporte | Affinda, Textkernel, RChilli, Daxtra, HireAbility. Están por delante en volumen, cobertura de taxonomías y casos borde, y cobran en consecuencia. |
| CVs escritos a mano, o fotos de celular de baja calidad (borrosas, en ángulo, mal iluminadas) | Tesseract no lee letra manuscrita ni corrige la perspectiva; los modelos de visión y Textract se defienden mejor, pero igual leen mal nombres, emails y fechas en fotos malas. Pedí un PDF o un escaneo limpio, o derivá estos casos a una persona. |
| Archivos `.doc` antiguos | Se rechazan. Guardalos como `.docx` o PDF primero. |
| Salida garantizada y reproducible para la misma entrada | La salida de un LLM varía entre ejecuciones y modelos. cvparse valida la forma, no la semántica. Fijá un modelo y una temperatura y evaluá con tus propios datos. |
| Matching, ranking o scoring de CV contra ofertas | cvparse solo extrae. Combinalo con un matcher como Resume-Matcher. |
| Python | Existen varios parsers de CV con LLM para Python. cvparse es solo TypeScript. |

## Hoja de ruta

Resumen; el plan completo está en [docs/ROADMAP.md](./docs/ROADMAP.md).

- **0.1** (hecho) — Extracción de texto de PDF con reconstrucción del orden de lectura para layouts a dos columnas y con barra lateral, entrada DOCX incluidas tablas y cuadros de texto, detección de formato por bytes, `extractText` / `detectFormat`. `npx @cvparse/core ./cv.pdf` funciona directamente. 0.1.1 sumó más formas de fecha, normalización de títulos para España y LATAM, y `temperature` / `referenceDate`.
- **0.2** (hecho, sin publicar) — CVs escaneados e imágenes: interfaz de adaptador de OCR intercambiable con adaptadores de referencia para Tesseract (local) y AWS Textract, modo visión para modelos multimodales, entrada PNG/JPEG/WebP/TIFF en el CLI, confianza del OCR en `source.ocr`.
- **0.3** — Dataset de evaluación público de CVs sintéticos en español con layouts difíciles, y un benchmark publicado contra open-resume.
- **Más adelante** — Empaquetado como agent skill y servidor MCP para usar cvparse directamente desde agentes de código y asistentes.

## Contribuir

Los issues y pull requests son bienvenidos. Leé primero [CONTRIBUTING.md](./CONTRIBUTING.md), en particular las reglas para los CVs de prueba: solo datos sintéticos, nunca el CV de una persona real. Se espera que todos los participantes sigan el [Código de Conducta](./CODE_OF_CONDUCT.md).

## Seguridad

Los CVs son datos personales. cvparse envía el texto (o, en modo visión, las imágenes de las páginas) únicamente al proveedor de modelo que configurás, más a AWS si elegís el adaptador de Textract, y a ningún otro lado. Para reportar una vulnerabilidad, ver [SECURITY.md](./SECURITY.md).

## Licencia

[MIT](./LICENSE) © 2026 Nikire

## Acerca de

cvparse está construido y mantenido por el fundador de Borderless ATS, donde parsear CVs en español de forma confiable es un problema diario y no una demo.
