/**
 * Seeded generator of FICTIONAL people for the evaluation dataset. Names, companies, schools,
 * phone numbers and e-mails are invented (e-mails only at example.com / example.org); any
 * resemblance to real people or organizations is coincidental.
 *
 * A {@link Person} carries full year+month dates; the precision that ends up in the ground truth
 * depends on the date style the renderer picks (see doc.ts).
 */

import type { DatasetCountry } from "../types.js";
import type { Rng } from "./rng.js";

export type Gender = "f" | "m";

export type RoleId =
  | "backend"
  | "data"
  | "ventas"
  | "rrhh"
  | "diseno"
  | "contabilidad"
  | "enfermeria"
  | "docencia";

export const ROLES: readonly RoleId[] = [
  "backend",
  "data",
  "ventas",
  "rrhh",
  "diseno",
  "contabilidad",
  "enfermeria",
  "docencia",
];

export type EducationLevelId =
  | "technical"
  | "bachelor"
  | "postgraduate"
  | "master"
  | "doctorate"
  | "course";

/** Year + month (1-12). */
export interface YM {
  year: number;
  month: number;
}

export interface Job {
  company: string;
  position: string;
  location: string;
  start: YM;
  /** `null` = ongoing. */
  end: YM | null;
  highlights: string[];
}

export interface Study {
  institution: string;
  /** Degree title family as written, e.g. "Licenciatura", "Máster", "Bootcamp". */
  studyType: string;
  /** Connector between studyType and area in the rendered title ("en", "de"). */
  connector: string;
  area: string;
  level: EducationLevelId;
  /** Canonical label cvparse uses for this title family (x_cvparse.educationLevels[].canonical). */
  canonical: string;
  /** `null` for single-date entries (short courses). */
  start: YM | null;
  /** `null` = ongoing (only when `start` is set). */
  end: YM | null;
  /** Short courses get a single date and may use the "verano 2020" style. */
  kind: "degree" | "course";
}

export interface SpokenLanguage {
  language: string;
  fluency: string;
}

export interface Person {
  country: DatasetCountry;
  gender: Gender;
  role: RoleId;
  firstNames: string;
  lastNames: string;
  name: string;
  label: string;
  email: string;
  phone: string;
  city: string;
  region: string;
  countryName: string;
  summary: string;
  jobs: Job[];
  studies: Study[];
  skills: string[];
  languages: SpokenLanguage[];
}

/** "Today" for the dataset: ongoing roles started before this month. */
export const REFERENCE: YM = { year: 2026, month: 9 };

// -------------------------------------------------------------------------------------------
// Names

interface NamePool {
  female: readonly string[];
  male: readonly string[];
  surnames: readonly string[];
  /** Probability of using two surnames (paternal + maternal). */
  twoSurnames: number;
  /** Probability of a compound first name ("María José", "Juan Pablo"). */
  compoundFirst: number;
}

const NAMES: Record<DatasetCountry, NamePool> = {
  ES: {
    female: ["Lucía", "Begoña", "Nerea", "Ainhoa", "Marta", "Inés", "Ángela", "Carmen", "Irene"],
    male: ["Iñaki", "Álvaro", "Sergio", "Jordi", "Rubén", "Adrián", "Íñigo", "Javier", "Óscar"],
    surnames: [
      "García",
      "Fernández",
      "Muñoz",
      "Ibáñez",
      "Sánchez",
      "Etxeberria",
      "Peña",
      "Martínez",
      "Ortega",
      "Castaño",
      "Vidal",
      "Serrano",
    ],
    twoSurnames: 0.9,
    compoundFirst: 0.2,
  },
  AR: {
    female: ["Florencia", "Agustina", "Milagros", "Sofía", "Camila", "Julieta", "Rocío", "Belén"],
    male: ["Martín", "Matías", "Joaquín", "Facundo", "Nicolás", "Tomás", "Gastón", "Ramiro"],
    surnames: [
      "Giménez",
      "Ferreyra",
      "Acuña",
      "Pereyra",
      "Rossi",
      "Benítez",
      "Ibarra",
      "Quiroga",
      "Bianchi",
      "Domínguez",
      "Núñez",
      "Sosa",
    ],
    twoSurnames: 0.2,
    compoundFirst: 0.3,
  },
  MX: {
    female: ["Guadalupe", "Ximena", "Fernanda", "Itzel", "Mariana", "Daniela", "Renata", "Paola"],
    male: ["José Luis", "Emiliano", "Santiago", "Diego", "Rodrigo", "Ángel", "Uriel", "Héctor"],
    surnames: [
      "Hernández",
      "Ramírez",
      "Cruz",
      "Ordóñez",
      "Treviño",
      "Zúñiga",
      "Velázquez",
      "Cervantes",
      "Montaño",
      "Arreola",
      "Ochoa",
      "Saldaña",
    ],
    twoSurnames: 0.85,
    compoundFirst: 0.25,
  },
  CO: {
    female: ["Valentina", "Juliana", "Natalia", "Andrea", "Luisa", "Catalina", "Manuela", "Paula"],
    male: ["Andrés", "Sebastián", "Camilo", "Esteban", "Julián", "Felipe", "Alejandro", "Óscar"],
    surnames: [
      "Restrepo",
      "Gómez",
      "Patiño",
      "Londoño",
      "Valencia",
      "Cárdenas",
      "Muñoz",
      "Ospina",
      "Castaño",
      "Jaramillo",
      "Peñaloza",
      "Ríos",
    ],
    twoSurnames: 0.85,
    compoundFirst: 0.3,
  },
  CL: {
    female: ["Constanza", "Javiera", "Catalina", "Francisca", "Antonia", "Trinidad", "Fernanda"],
    male: ["Benjamín", "Vicente", "Matías", "Cristóbal", "Ignacio", "Tomás", "Joaquín", "Agustín"],
    surnames: [
      "González",
      "Muñoz",
      "Rojas",
      "Díaz",
      "Soto",
      "Contreras",
      "Sepúlveda",
      "Fuentealba",
      "Araya",
      "Valdés",
      "Núñez",
      "Cañas",
    ],
    twoSurnames: 0.85,
    compoundFirst: 0.2,
  },
  PE: {
    female: ["Rosa", "Milagros", "Claudia", "Lucía", "Gabriela", "Yesenia", "Fiorella", "Diana"],
    male: ["Luis", "Renzo", "Piero", "César", "Jhon", "Martín", "Raúl", "Álex"],
    surnames: [
      "Quispe",
      "Mamani",
      "Huamán",
      "Flores",
      "Chávez",
      "Vásquez",
      "Rodríguez",
      "Ccori",
      "Gutiérrez",
      "Paredes",
      "Yupanqui",
      "Peña",
    ],
    twoSurnames: 0.85,
    compoundFirst: 0.2,
  },
  UY: {
    female: ["Lucía", "Valentina", "Sofía", "Florencia", "Mariana", "Victoria", "Agustina"],
    male: ["Facundo", "Bruno", "Federico", "Gonzalo", "Santiago", "Sebastián", "Rodrigo"],
    surnames: [
      "Rodríguez",
      "Pereira",
      "Fernández",
      "Olivera",
      "Silva",
      "Techera",
      "Núñez",
      "Píriz",
      "Cabrera",
      "Rodríguez",
      "Viñoly",
      "Sosa",
    ],
    twoSurnames: 0.35,
    compoundFirst: 0.25,
  },
};

// -------------------------------------------------------------------------------------------
// Places and phones

interface Place {
  city: string;
  region: string;
  /** Phone area code for the countries that need one. */
  area?: string;
}

const COUNTRY_NAMES: Record<DatasetCountry, string> = {
  ES: "España",
  AR: "Argentina",
  MX: "México",
  CO: "Colombia",
  CL: "Chile",
  PE: "Perú",
  UY: "Uruguay",
};

const PLACES: Record<DatasetCountry, readonly Place[]> = {
  ES: [
    { city: "Madrid", region: "Comunidad de Madrid" },
    { city: "Barcelona", region: "Cataluña" },
    { city: "Valencia", region: "Comunidad Valenciana" },
    { city: "Sevilla", region: "Andalucía" },
    { city: "Bilbao", region: "País Vasco" },
    { city: "Zaragoza", region: "Aragón" },
  ],
  AR: [
    { city: "Buenos Aires", region: "CABA", area: "11" },
    { city: "Córdoba", region: "Córdoba", area: "351" },
    { city: "Rosario", region: "Santa Fe", area: "341" },
    { city: "Mendoza", region: "Mendoza", area: "261" },
    { city: "La Plata", region: "Buenos Aires", area: "221" },
  ],
  MX: [
    { city: "Ciudad de México", region: "CDMX", area: "55" },
    { city: "Guadalajara", region: "Jalisco", area: "33" },
    { city: "Monterrey", region: "Nuevo León", area: "81" },
    { city: "Puebla", region: "Puebla", area: "222" },
    { city: "Mérida", region: "Yucatán", area: "999" },
  ],
  CO: [
    { city: "Bogotá", region: "Bogotá D.C." },
    { city: "Medellín", region: "Antioquia" },
    { city: "Cali", region: "Valle del Cauca" },
    { city: "Barranquilla", region: "Atlántico" },
    { city: "Bucaramanga", region: "Santander" },
  ],
  CL: [
    { city: "Santiago", region: "Región Metropolitana" },
    { city: "Valparaíso", region: "Valparaíso" },
    { city: "Concepción", region: "Biobío" },
    { city: "Antofagasta", region: "Antofagasta" },
  ],
  PE: [
    { city: "Lima", region: "Lima" },
    { city: "Arequipa", region: "Arequipa" },
    { city: "Trujillo", region: "La Libertad" },
    { city: "Cusco", region: "Cusco" },
  ],
  UY: [
    { city: "Montevideo", region: "Montevideo" },
    { city: "Maldonado", region: "Maldonado" },
    { city: "Salto", region: "Salto" },
    { city: "Paysandú", region: "Paysandú" },
  ],
};

function phoneFor(country: DatasetCountry, place: Place, rng: Rng): string {
  switch (country) {
    case "ES":
      return `+34 6${rng.digits(2)} ${rng.digits(3)} ${rng.digits(3)}`;
    case "AR": {
      const area = place.area ?? "11";
      // Area code + local number always add up to 10 digits.
      const local = 10 - area.length;
      const head = rng.digits(local - 4, 4);
      return `+54 9 ${area} ${head}-${rng.digits(4)}`;
    }
    case "MX": {
      const area = place.area ?? "55";
      return area.length === 2
        ? `+52 ${area} ${rng.digits(4, 1)} ${rng.digits(4)}`
        : `+52 ${area} ${rng.digits(3, 1)} ${rng.digits(4)}`;
    }
    case "CO":
      return `+57 3${rng.digits(2)} ${rng.digits(3)} ${rng.digits(4)}`;
    case "CL":
      return `+56 9 ${rng.digits(4, 2)} ${rng.digits(4)}`;
    case "PE":
      return `+51 9${rng.digits(2)} ${rng.digits(3)} ${rng.digits(3)}`;
    case "UY":
      return `+598 9${rng.digits(1, 1)} ${rng.digits(3)} ${rng.digits(3)}`;
  }
}

// -------------------------------------------------------------------------------------------
// Companies and schools (all invented)

const LEGAL: Record<DatasetCountry, readonly string[]> = {
  ES: ["S.L.", "S.A.", "S.L."],
  AR: ["S.A.", "S.R.L.", "S.A.S."],
  MX: ["S.A. de C.V.", "S.A.P.I. de C.V.", "S. de R.L. de C.V."],
  CO: ["S.A.S.", "S.A.", "Ltda."],
  CL: ["SpA", "Ltda.", "S.A."],
  PE: ["S.A.C.", "S.A.", "E.I.R.L."],
  UY: ["S.A.", "S.R.L.", "S.A."],
};

/** Regional adjective used in invented company names. */
/** Gender-neutral regional qualifiers, so they agree with any noun ("Liceo", "Clínica"). */
const REGIONAL: Record<DatasetCountry, readonly string[]> = {
  ES: ["de Levante", "del Mediterráneo", "del Cantábrico", "del Ebro"],
  AR: ["del Plata", "del Litoral", "del Sur", "de los Andes"],
  MX: ["del Bajío", "Azteca", "del Pacífico", "del Norte"],
  CO: ["de los Andes", "del Caribe", "Paisa", "del Valle"],
  CL: ["Austral", "del Pacífico", "de los Andes", "del Norte Grande"],
  PE: ["de los Andes", "del Rímac", "Inca", "del Pacífico"],
  UY: ["Oriental", "del Plata", "Charrúa", "del Este"],
};

interface RoleData {
  label: { f: string; m: string };
  /** Positions from junior to senior; "{o/a}" style placeholders are resolved by gender. */
  positions: readonly string[];
  /** Company name stems; "%R" is replaced by a regional adjective. */
  companies: readonly string[];
  /** Organizations that take no legal suffix (hospitals, schools). */
  bareCompanies?: boolean;
  highlights: readonly string[];
  skills: readonly string[];
  /** Areas of study per title family. */
  areas: {
    bachelor: readonly string[];
    engineering?: readonly string[];
    technical: readonly string[];
    postgraduate: readonly string[];
    master: readonly string[];
    doctorate: readonly string[];
    course: readonly string[];
  };
  summary: string;
}

const ROLE_DATA: Record<RoleId, RoleData> = {
  backend: {
    label: { f: "Desarrolladora Backend", m: "Desarrollador Backend" },
    positions: [
      "Desarrollador{/a} Backend Jr.",
      "Desarrollador{/a} Backend",
      "Desarrollador{/a} Backend Sr.",
      "Tech Lead Backend",
      "Ingenier{o/a} de Software",
    ],
    companies: [
      "Fintech %R",
      "Nube %R",
      "Pagos %R",
      "Código Abierto %R",
      "Logística Digital %R",
      "Datacenter %R",
    ],
    highlights: [
      "Diseño de APIs REST con NestJS y PostgreSQL para {n} mil usuarios activos.",
      "Migración de un monolito a microservicios con Docker y Kubernetes.",
      "Reducción del tiempo de despliegue de {n} a 8 minutos con GitHub Actions.",
      "Integración con pasarelas de pago y facturación electrónica.",
      "Mentoría de {s} desarrolladores junior.",
      "Implementación de colas con Kafka para procesar {n} mil eventos diarios.",
    ],
    skills: [
      "Node.js",
      "TypeScript",
      "NestJS",
      "PostgreSQL",
      "MongoDB",
      "Docker",
      "Kubernetes",
      "AWS",
      "Kafka",
      "Redis",
      "Go",
      "Java",
      "GraphQL",
      "Git",
    ],
    areas: {
      bachelor: ["Ciencias de la Computación", "Sistemas", "Informática"],
      engineering: ["Sistemas de Información", "Informática", "Software"],
      technical: ["Programación", "Desarrollo de Software"],
      postgraduate: ["Ingeniería de Software"],
      master: ["Ingeniería de Software", "Ciencia de Datos"],
      doctorate: ["Ciencias de la Computación"],
      course: ["Arquitectura de Microservicios", "Desarrollo Web Full Stack", "AWS Cloud"],
    },
    summary:
      "{label} con {y} años de experiencia construyendo APIs y sistemas distribuidos. Me interesan la calidad del código, la observabilidad y el trabajo en equipo.",
  },
  data: {
    label: { f: "Analista de Datos", m: "Analista de Datos" },
    positions: [
      "Analista de Datos Jr.",
      "Analista de Datos",
      "Analista de Datos Sr.",
      "Científic{o/a} de Datos",
      "Ingenier{o/a} de Datos",
    ],
    companies: [
      "Datos %R",
      "Analítica %R",
      "Retail %R",
      "Banco Digital %R",
      "Seguros %R",
      "Telecom %R",
    ],
    highlights: [
      "Tableros de seguimiento comercial en Power BI para {s} gerencias.",
      "Modelos de scoring crediticio con Python y SQL.",
      "Automatización de cargas ETL que ahorró {n} horas mensuales.",
      "Pronóstico de demanda con un error medio del {s}%.",
      "Gobierno de datos y documentación del catálogo corporativo.",
    ],
    skills: [
      "Python",
      "SQL",
      "Power BI",
      "Tableau",
      "pandas",
      "scikit-learn",
      "Spark",
      "Airflow",
      "Excel avanzado",
      "BigQuery",
      "dbt",
      "R",
    ],
    areas: {
      bachelor: ["Estadística", "Economía", "Matemática Aplicada"],
      engineering: ["Industrial", "Sistemas"],
      technical: ["Análisis de Datos", "Programación"],
      postgraduate: ["Ciencia de Datos", "Inteligencia de Negocios"],
      master: ["Ciencia de Datos", "Estadística Aplicada"],
      doctorate: ["Estadística", "Ciencia de Datos"],
      course: ["Machine Learning", "Power BI", "Ciencia de Datos"],
    },
    summary:
      "{label} con {y} años de experiencia transformando datos en decisiones de negocio. Experiencia en modelado estadístico, visualización y automatización de reportes.",
  },
  ventas: {
    label: { f: "Ejecutiva Comercial", m: "Ejecutivo Comercial" },
    positions: [
      "Asesor{/a} Comercial",
      "Ejecutiv{o/a} de Cuentas",
      "Ejecutiv{o/a} de Cuentas Senior",
      "Jef{e/a} de Ventas",
      "Key Account Manager",
    ],
    companies: [
      "Distribuidora %R",
      "Grupo Logístico %R",
      "Insumos Médicos %R",
      "Alimentos %R",
      "Software Empresarial %R",
      "Maquinarias %R",
    ],
    highlights: [
      "Cumplimiento del {n}% de la meta anual de ventas.",
      "Gestión de una cartera de {n} clientes corporativos.",
      "Apertura de {s} cuentas nuevas en el sector salud.",
      "Capacitación de {s} asesores comerciales nuevos.",
      "Negociación de contratos marco con cadenas de retail.",
    ],
    skills: [
      "Negociación",
      "Salesforce",
      "HubSpot",
      "Prospección B2B",
      "Excel avanzado",
      "Presentaciones ejecutivas",
      "Gestión de cartera",
      "Atención al cliente",
      "Pronóstico de ventas",
    ],
    areas: {
      bachelor: ["Administración de Empresas", "Marketing", "Comercio Internacional"],
      engineering: ["Comercial", "Industrial"],
      technical: ["Comercialización", "Marketing"],
      postgraduate: ["Gerencia Comercial", "Marketing Digital"],
      master: ["Dirección Comercial", "Marketing"],
      doctorate: ["Administración"],
      course: ["Ventas Consultivas", "Negociación Estratégica", "Marketing Digital"],
    },
    summary:
      "{label} con {y} años de experiencia en ventas consultivas B2B. Orientación a resultados, relación de largo plazo con clientes y cumplimiento de metas.",
  },
  rrhh: {
    label: { f: "Analista de Recursos Humanos", m: "Analista de Recursos Humanos" },
    positions: [
      "Asistente de Recursos Humanos",
      "Analista de Selección",
      "Analista de Recursos Humanos",
      "HR Business Partner",
      "Jef{e/a} de Recursos Humanos",
    ],
    companies: [
      "Consultora %R",
      "Talento %R",
      "Grupo Industrial %R",
      "Servicios Financieros %R",
      "Retail %R",
    ],
    highlights: [
      "Selección de {n} perfiles técnicos y comerciales por año.",
      "Implementación de la evaluación de desempeño 360°.",
      "Reducción de la rotación voluntaria del {s}%.",
      "Liquidación de haberes para {n} colaboradores.",
      "Diseño del programa de onboarding y clima laboral.",
    ],
    skills: [
      "Reclutamiento y selección",
      "Entrevistas por competencias",
      "Clima laboral",
      "Liquidación de sueldos",
      "Legislación laboral",
      "Workday",
      "SAP SuccessFactors",
      "Excel avanzado",
      "Capacitación",
    ],
    areas: {
      bachelor: ["Psicología", "Relaciones del Trabajo", "Recursos Humanos"],
      technical: ["Recursos Humanos", "Administración de Personal"],
      postgraduate: ["Gestión del Talento Humano", "Psicología Organizacional"],
      master: ["Dirección de Recursos Humanos", "Psicología Organizacional"],
      doctorate: ["Psicología"],
      course: ["Gestión del Talento", "People Analytics", "Selección por Competencias"],
    },
    summary:
      "{label} con {y} años de experiencia en selección, desarrollo y clima organizacional. Acompaño a líderes en la gestión de equipos y procesos de cambio.",
  },
  diseno: {
    label: { f: "Diseñadora UX/UI", m: "Diseñador UX/UI" },
    positions: [
      "Diseñador{/a} Gráfic{o/a}",
      "Diseñador{/a} UX/UI",
      "Product Designer",
      "Product Designer Senior",
      "Líder de Diseño",
    ],
    companies: [
      "Estudio Creativo %R",
      "Agencia Digital %R",
      "Banco Digital %R",
      "Tienda %R",
      "Apps %R",
    ],
    highlights: [
      "Rediseño del onboarding móvil que subió la conversión al {n}%.",
      "Creación de un design system usado por {s} equipos.",
      "Investigación con usuarios y pruebas de usabilidad quincenales.",
      "Diseño del checkout y la búsqueda con filtros.",
      "Identidad visual para {s} marcas de consumo masivo.",
    ],
    skills: [
      "Figma",
      "Design systems",
      "Investigación con usuarios",
      "Prototipado",
      "Adobe Illustrator",
      "Adobe Photoshop",
      "HTML y CSS",
      "Accesibilidad web",
      "Tipografía",
    ],
    areas: {
      bachelor: ["Diseño Gráfico", "Diseño Multimedia", "Diseño Industrial"],
      technical: ["Diseño Gráfico", "Diseño Web"],
      postgraduate: ["Diseño de Interacción"],
      master: ["Diseño de Experiencia de Usuario", "Diseño Estratégico"],
      doctorate: ["Diseño"],
      course: ["UX Research", "Diseño de Interfaces", "Diseño UX/UI"],
    },
    summary:
      "{label} con {y} años de experiencia en productos digitales para fintech y e-commerce. Combino investigación con usuarios, prototipado y sistemas de diseño escalables.",
  },
  contabilidad: {
    label: { f: "Contadora", m: "Contador" },
    positions: [
      "Auxiliar Contable",
      "Analista Contable",
      "Contador{/a} Senior",
      "Jef{e/a} de Contabilidad",
      "Controller Financier{o/a}",
    ],
    companies: [
      "Estudio Contable %R",
      "Auditores %R",
      "Agroindustrias %R",
      "Constructora %R",
      "Farmacéutica %R",
    ],
    highlights: [
      "Cierres contables mensuales y estados financieros bajo NIIF.",
      "Conciliaciones bancarias de {s} cuentas corrientes.",
      "Liquidación de impuestos y presentación de declaraciones juradas.",
      "Reducción del cierre mensual de {s} a 3 días hábiles.",
      "Coordinación con auditores externos en la auditoría anual.",
    ],
    skills: [
      "NIIF",
      "SAP FI",
      "Excel avanzado",
      "Conciliaciones bancarias",
      "Impuestos",
      "Auditoría",
      "Presupuestos",
      "Costos",
      "Power BI",
    ],
    areas: {
      bachelor: ["Contaduría Pública", "Contabilidad", "Administración y Finanzas"],
      technical: ["Contabilidad", "Administración Contable"],
      postgraduate: ["Tributación", "Finanzas Corporativas"],
      master: ["Finanzas", "Contabilidad y Auditoría"],
      doctorate: ["Ciencias Económicas"],
      course: ["NIIF para Pymes", "Excel Financiero", "Tributación"],
    },
    summary:
      "{label} con {y} años de experiencia en contabilidad general, impuestos y cierres mensuales. Manejo de ERP y relación con auditores externos.",
  },
  enfermeria: {
    label: { f: "Enfermera", m: "Enfermero" },
    positions: [
      "Enfermer{o/a}",
      "Enfermer{o/a} de Terapia Intensiva",
      "Enfermer{o/a} Asistencial",
      "Supervisor{/a} de Enfermería",
      "Coordinador{/a} de Enfermería",
    ],
    companies: [
      "Clínica Santa Brígida %R",
      "Hospital Privado %R",
      "Sanatorio %R",
      "Centro Médico %R",
      "Clínica del Parque %R",
    ],
    bareCompanies: true,
    highlights: [
      "Atención de pacientes críticos en una unidad de {s}0 camas.",
      "Administración de medicación y control de signos vitales.",
      "Capacitación al personal en bioseguridad.",
      "Coordinación de turnos de {s} enfermeros.",
      "Registro clínico en historia electrónica.",
    ],
    skills: [
      "Cuidados intensivos",
      "RCP avanzada",
      "Bioseguridad",
      "Administración de medicamentos",
      "Historia clínica electrónica",
      "Triage",
      "Curación de heridas",
      "Atención domiciliaria",
    ],
    areas: {
      bachelor: ["Enfermería"],
      technical: ["Enfermería"],
      postgraduate: ["Enfermería en Cuidados Críticos", "Enfermería Oncológica"],
      master: ["Gestión de Servicios de Salud", "Enfermería"],
      doctorate: ["Ciencias de la Salud"],
      course: ["Soporte Vital Avanzado", "Control de Infecciones", "Cuidados Paliativos"],
    },
    summary:
      "{label} con {y} años de experiencia en atención de pacientes adultos y cuidados críticos. Trato humano, trabajo en equipo y registro clínico riguroso.",
  },
  docencia: {
    label: { f: "Docente", m: "Docente" },
    positions: [
      "Docente de Nivel Secundario",
      "Profesor{/a} de Matemática",
      "Coordinador{/a} Académic{o/a}",
      "Profesor{/a} Adjunt{o/a}",
      "Investigador{/a} Asistente",
    ],
    companies: [
      "Colegio Santa Inés %R",
      "Instituto Belgrano %R",
      "Liceo %R",
      "Universidad del Delta %R",
      "Escuela Técnica %R",
    ],
    bareCompanies: true,
    highlights: [
      "Dictado de clases a {s} cursos de nivel secundario.",
      "Diseño de planificaciones y materiales didácticos digitales.",
      "Coordinación del área de ciencias con {s} docentes.",
      "Dirección de {s} tesis de grado.",
      "Implementación de aulas virtuales en Moodle.",
    ],
    skills: [
      "Planificación didáctica",
      "Moodle",
      "Evaluación por competencias",
      "Google Classroom",
      "Educación inclusiva",
      "Investigación educativa",
      "Oratoria",
      "Tutoría",
    ],
    areas: {
      bachelor: ["Ciencias de la Educación", "Matemática", "Letras"],
      technical: ["Educación Inicial", "Pedagogía"],
      postgraduate: ["Docencia Universitaria", "Educación y TIC"],
      master: ["Educación", "Didáctica de la Matemática"],
      doctorate: ["Educación", "Ciencias de la Educación"],
      course: ["Didáctica Digital", "Educación Inclusiva", "Moodle para Docentes"],
    },
    summary:
      "{label} con {y} años de experiencia en enseñanza, planificación curricular e investigación educativa. Me interesa la innovación pedagógica con tecnología.",
  },
};

// -------------------------------------------------------------------------------------------
// Degrees per country

interface DegreeType {
  studyType: string;
  connector: string;
  level: EducationLevelId;
  canonical: string;
  /** Which area list to draw from. */
  areas: keyof RoleData["areas"];
}

const d = (
  studyType: string,
  level: EducationLevelId,
  canonical: string,
  areas: keyof RoleData["areas"],
  connector = "en",
): DegreeType => ({ studyType, connector, level, canonical, areas });

interface CountryDegrees {
  bachelor: readonly DegreeType[];
  technical: readonly DegreeType[];
  postgraduate: readonly DegreeType[];
  master: readonly DegreeType[];
  doctorate: DegreeType;
  course: readonly DegreeType[];
  /** Month (1-12) the academic year starts / ends. */
  startMonth: number;
  endMonth: number;
}

const BOOTCAMP = d("Bootcamp", "course", "Bootcamp", "course", "de");
const CURSO = d("Curso", "course", "Curso", "course", "de");
const DIPLOMADO = d("Diplomado", "course", "Diplomado", "course");
const DOCTORADO = d("Doctorado", "doctorate", "Doctorado", "doctorate");
const MAESTRIA = d("Maestría", "master", "Maestría", "master");
const MBA = d("MBA", "master", "MBA", "master", "con orientación en");
const ESPECIALIZACION = d("Especialización", "postgraduate", "Especialización", "postgraduate");
const LICENCIATURA = d("Licenciatura", "bachelor", "Licenciatura", "bachelor");
const INGENIERIA = d("Ingeniería", "bachelor", "Ingeniería", "engineering");
const TECNOLOGO = d("Tecnólogo", "technical", "Tecnólogo", "technical");

const DEGREES: Record<DatasetCountry, CountryDegrees> = {
  ES: {
    bachelor: [d("Grado", "bachelor", "Grado", "bachelor")],
    technical: [d("Técnico Superior", "technical", "Técnico Superior", "technical")],
    postgraduate: [d("Máster", "master", "Máster", "master")],
    master: [d("Máster", "master", "Máster", "master"), MBA],
    doctorate: DOCTORADO,
    course: [CURSO, BOOTCAMP],
    startMonth: 9,
    endMonth: 6,
  },
  AR: {
    bachelor: [LICENCIATURA, INGENIERIA],
    technical: [d("Tecnicatura", "technical", "Tecnicatura", "technical")],
    postgraduate: [ESPECIALIZACION],
    master: [MAESTRIA, MBA],
    doctorate: DOCTORADO,
    course: [CURSO, BOOTCAMP],
    startMonth: 3,
    endMonth: 12,
  },
  MX: {
    bachelor: [LICENCIATURA, INGENIERIA],
    technical: [d("Técnico Superior Universitario", "technical", "Técnico Superior", "technical")],
    postgraduate: [ESPECIALIZACION],
    master: [MAESTRIA, MBA],
    doctorate: DOCTORADO,
    course: [DIPLOMADO, BOOTCAMP],
    startMonth: 8,
    endMonth: 6,
  },
  CO: {
    bachelor: [INGENIERIA, LICENCIATURA],
    technical: [TECNOLOGO],
    postgraduate: [ESPECIALIZACION],
    master: [MAESTRIA],
    doctorate: DOCTORADO,
    course: [DIPLOMADO, CURSO],
    startMonth: 2,
    endMonth: 11,
  },
  CL: {
    bachelor: [INGENIERIA, LICENCIATURA],
    technical: [d("Técnico de Nivel Superior", "technical", "Técnico", "technical")],
    postgraduate: [DIPLOMADO],
    master: [d("Magíster", "master", "Maestría", "master"), MBA],
    doctorate: DOCTORADO,
    course: [DIPLOMADO, BOOTCAMP],
    startMonth: 3,
    endMonth: 12,
  },
  PE: {
    bachelor: [LICENCIATURA, INGENIERIA],
    technical: [d("Técnico Profesional", "technical", "Técnico", "technical")],
    postgraduate: [DIPLOMADO],
    master: [MAESTRIA, MBA],
    doctorate: DOCTORADO,
    course: [DIPLOMADO, CURSO],
    startMonth: 3,
    endMonth: 12,
  },
  UY: {
    bachelor: [LICENCIATURA, INGENIERIA],
    technical: [TECNOLOGO],
    postgraduate: [ESPECIALIZACION],
    master: [MAESTRIA],
    doctorate: DOCTORADO,
    course: [CURSO, BOOTCAMP],
    startMonth: 3,
    endMonth: 12,
  },
};

const UNIVERSITY_STEMS: Record<DatasetCountry, readonly string[]> = {
  ES: [
    "Universidad Politécnica del Cantábrico",
    "Universidad de la Ribera",
    "Universitat del Mediterrani Occidental",
    "Universidad Castellana de Ciencias",
  ],
  AR: [
    "Universidad Nacional de la Pampa Húmeda",
    "Universidad Tecnológica del Plata",
    "Instituto Universitario Río Paraná",
    "Universidad del Litoral Pampeano",
  ],
  MX: [
    "Universidad Autónoma del Bajío Central",
    "Instituto Tecnológico de Tlalnepantla Norte",
    "Universidad Interamericana del Pacífico",
    "Universidad Popular de Tlaxcalpan",
  ],
  CO: [
    "Universidad Pontificia del Valle de Aburrá",
    "Universidad Nacional del Magdalena Medio",
    "Fundación Universitaria Andina del Café",
    "Universidad Tecnológica del Altiplano",
  ],
  CL: [
    "Universidad Técnica del Pacífico Sur",
    "Pontificia Universidad de los Andes Australes",
    "Universidad del Norte Grande",
    "Universidad del Estrecho Austral",
  ],
  PE: [
    "Universidad Nacional del Rímac",
    "Pontificia Universidad Católica del Misti",
    "Universidad Peruana de Ciencias del Pacífico",
    "Universidad Andina de Chachani",
  ],
  UY: [
    "Universidad del Este Oriental",
    "Universidad Católica del Río de la Plata",
    "Universidad Técnica del Este",
    "Instituto Universitario Charrúa",
  ],
};

const TECH_INSTITUTES: Record<DatasetCountry, readonly string[]> = {
  ES: ["IES Ribera del Ebro", "Centro de FP Mediterráneo"],
  AR: ["Instituto Superior de Formación Técnica N.º 180", "Instituto Técnico del Plata"],
  MX: ["Universidad Tecnológica del Valle de Tlaxcalpan", "Instituto Técnico del Bajío"],
  CO: ["Servicio Técnico Regional Andino", "Corporación Tecnológica del Caribe"],
  CL: ["Instituto Profesional del Pacífico", "Centro de Formación Técnica Austral"],
  PE: ["Instituto Tecnológico del Rímac", "Instituto Superior Tecnológico Inca"],
  UY: ["Escuela Técnica Polo del Este", "Instituto Técnico Charrúa"],
};

const COURSE_PROVIDERS: readonly string[] = [
  "Academia Código Libre",
  "Escuela de Negocios del Sur",
  "Plataforma Aprende+",
  "Instituto de Formación Continua",
  "Laboratorio Digital Latam",
];

// -------------------------------------------------------------------------------------------
// Languages

const FLUENCY_OTHER: readonly string[] = [
  "B2",
  "C1",
  "Avanzado",
  "Intermedio",
  "Básico",
  "Avanzado (C1)",
  "Intermedio (B1)",
];

const EXTRA_LANGUAGES: Record<DatasetCountry, readonly string[]> = {
  ES: ["Francés", "Catalán", "Alemán", "Italiano"],
  AR: ["Portugués", "Italiano", "Francés"],
  MX: ["Francés", "Portugués", "Alemán"],
  CO: ["Portugués", "Francés"],
  CL: ["Portugués", "Francés", "Alemán"],
  PE: ["Quechua", "Portugués", "Francés"],
  UY: ["Portugués", "Italiano", "Francés"],
};

// -------------------------------------------------------------------------------------------
// Helpers

/** Resolves "{m/f}" placeholders: "Desarrollador{/a}" -> "Desarrolladora" for women. */
export function gendered(text: string, gender: Gender): string {
  return text.replace(/\{([^/}]*)\/([^}]*)\}/g, (_m, male: string, female: string) =>
    gender === "f" ? female : male,
  );
}

/** ASCII-folds a name part for e-mail local parts. */
function emailPart(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export function addMonths(ym: YM, delta: number): YM {
  const index = ym.year * 12 + (ym.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function monthsBetween(a: YM, b: YM): number {
  return b.year * 12 + b.month - (a.year * 12 + a.month);
}

function fillNumbers(template: string, rng: Rng): string {
  return template
    .replace(/\{n\}/g, () => String(rng.int(2, 9) * 10 + rng.int(0, 9)))
    .replace(/\{s\}/g, () => String(rng.int(2, 9)));
}

// -------------------------------------------------------------------------------------------
// Generator

export interface PersonOptions {
  /** Number of jobs (2-4). */
  jobs: number;
  /** Highlights per job [min, max]. */
  highlights: [number, number];
  /** Probability that the most recent job is ongoing. */
  ongoing: number;
  /** Include a postgraduate / master degree. */
  postgraduate: boolean;
  /** Include a doctorate (academic CVs). */
  doctorate: boolean;
  /** Include a short course (bootcamp, curso, diplomado). */
  course: boolean;
  /** Prefer a technical (non-university) first degree. */
  technical: boolean;
  /** Number of skills. */
  skills: number;
}

export function generatePerson(
  rng: Rng,
  country: DatasetCountry,
  role: RoleId,
  options: PersonOptions,
): Person {
  const pool = NAMES[country];
  const gender: Gender = rng.chance(0.5) ? "f" : "m";
  const firstPool = gender === "f" ? pool.female : pool.male;
  const first = rng.pick(firstPool);
  let firstNames = first;
  if (rng.chance(pool.compoundFirst) && !first.includes(" ")) {
    const second = rng.pick(firstPool.filter((name) => name !== first && !name.includes(" ")));
    firstNames = `${first} ${second}`;
  }
  const surname1 = rng.pick(pool.surnames);
  const lastNames = rng.chance(pool.twoSurnames)
    ? `${surname1} ${rng.pick(pool.surnames.filter((s) => s !== surname1))}`
    : surname1;
  const name = `${firstNames} ${lastNames}`;

  const surnameFirst = lastNames.split(" ")[0] ?? lastNames;
  const firstWord = firstNames.split(" ")[0] ?? firstNames;
  const local = rng.pick([
    `${emailPart(firstWord)}.${emailPart(surnameFirst)}`,
    `${emailPart(firstWord).slice(0, 1)}${emailPart(surnameFirst)}`,
    `${emailPart(firstWord)}${emailPart(surnameFirst)}${rng.int(10, 99)}`,
    `${emailPart(firstWord)}_${emailPart(surnameFirst)}`,
  ]);
  const email = `${local}@${rng.pick(["example.com", "example.org"])}`;

  const place = rng.pick(PLACES[country]);
  const phone = phoneFor(country, place, rng);
  const data = ROLE_DATA[role];
  const regional = REGIONAL[country];

  // --- Work, most recent first -----------------------------------------------------------------
  const companyStems = rng.shuffle(data.companies);
  const positions = data.positions;
  const jobs: Job[] = [];
  let cursor: YM | null = null;
  const ongoing = rng.chance(options.ongoing);
  // Highlights are dealt from a shuffled deck so they only repeat once the pool runs out.
  const deck: string[] = [];
  // Strictly decreasing seniority going back in time, so consecutive positions differ.
  const seniorityBase = Math.min(positions.length - 1, options.jobs - 1 + rng.int(0, 1));
  for (let i = 0; i < options.jobs; i++) {
    let start: YM;
    let end: YM | null;
    if (i === 0) {
      if (ongoing) {
        end = null;
        start = addMonths(REFERENCE, -rng.int(8, 60));
      } else {
        end = addMonths(REFERENCE, -rng.int(1, 10));
        start = addMonths(end, -rng.int(14, 48));
      }
    } else {
      end = addMonths(cursor as YM, -rng.int(1, 4));
      start = addMonths(end, -rng.int(14, 50));
    }
    cursor = start;
    const stem = (companyStems[i % companyStems.length] as string).replace(
      "%R",
      rng.pick(regional),
    );
    const company = data.bareCompanies ? stem : `${stem} ${rng.pick(LEGAL[country])}`;
    // Seniority goes down as we go back in time.
    const seniority = Math.max(0, seniorityBase - i);
    const position = gendered(positions[seniority] as string, gender);
    const location = rng.chance(0.15)
      ? "Remoto"
      : rng.chance(0.7)
        ? place.city
        : rng.pick(PLACES[country]).city;
    const count = rng.int(options.highlights[0], options.highlights[1]);
    const highlights: string[] = [];
    for (let k = 0; k < count; k++) {
      if (deck.length === 0) deck.push(...rng.shuffle(data.highlights));
      highlights.push(fillNumbers(deck.pop() as string, rng));
    }
    jobs.push({ company, position, location, start, end, highlights });
  }
  const firstJobStart = cursor as YM;

  // --- Education, most recent first -----------------------------------------------------------
  const degrees = DEGREES[country];
  const pickArea = (type: DegreeType): string => {
    const list = data.areas[type.areas] ?? data.areas.bachelor;
    return rng.pick(list);
  };
  const universities = rng.shuffle(UNIVERSITY_STEMS[country]);
  const studies: Study[] = [];

  // First degree: ends 0-1 years before the first job.
  const firstType = options.technical
    ? rng.pick(degrees.technical)
    : rng.pick(
        data.areas.engineering
          ? degrees.bachelor
          : degrees.bachelor.filter((t) => t !== INGENIERIA),
      );
  const firstYears = firstType.level === "technical" ? rng.int(2, 3) : rng.int(4, 6);
  const firstEnd: YM = {
    year: firstJobStart.year - rng.int(0, 1),
    month: degrees.endMonth,
  };
  const firstStart: YM = { year: firstEnd.year - firstYears, month: degrees.startMonth };
  const first0: Study = {
    institution:
      firstType.level === "technical"
        ? rng.pick(TECH_INSTITUTES[country])
        : (universities[0] as string),
    studyType: firstType.studyType,
    connector: firstType.connector,
    area: pickArea(firstType),
    level: firstType.level,
    canonical: firstType.canonical,
    start: firstStart,
    end: firstEnd,
    kind: "degree",
  };

  const later: Study[] = [];
  let postEnd: YM | null = firstEnd;
  if (options.postgraduate || options.doctorate) {
    const type = options.doctorate
      ? rng.pick(degrees.master)
      : rng.pick([...degrees.master, ...degrees.postgraduate]);
    const startYear = Math.min(firstEnd.year + rng.int(1, 3), REFERENCE.year - 1);
    const years = type.level === "master" ? 2 : 1;
    const start: YM = { year: startYear, month: degrees.startMonth };
    let end: YM | null = { year: startYear + years, month: degrees.endMonth };
    if (end.year * 12 + end.month > REFERENCE.year * 12 + REFERENCE.month) end = null;
    later.push({
      institution: universities[1] as string,
      studyType: type.studyType,
      connector: type.connector,
      area: pickArea(type),
      level: type.level,
      canonical: type.canonical,
      start,
      end,
      kind: "degree",
    });
    postEnd = end;
  }
  if (options.doctorate) {
    const type = degrees.doctorate;
    const startYear = Math.min(
      (postEnd?.year ?? firstEnd.year + 3) + rng.int(0, 1),
      REFERENCE.year - 2,
    );
    const years = rng.int(4, 5);
    const start: YM = { year: startYear, month: degrees.startMonth };
    let end: YM | null = { year: startYear + years, month: degrees.endMonth };
    if (end.year * 12 + end.month > REFERENCE.year * 12 + REFERENCE.month) end = null;
    later.push({
      institution: universities[2] as string,
      studyType: type.studyType,
      connector: type.connector,
      area: pickArea(type),
      level: type.level,
      canonical: type.canonical,
      start,
      end,
      kind: "degree",
    });
  }
  if (options.course) {
    const type = rng.pick(degrees.course);
    const date: YM = { year: rng.int(Math.max(firstEnd.year, 2016), 2025), month: rng.int(1, 12) };
    later.push({
      institution: rng.pick(COURSE_PROVIDERS),
      studyType: type.studyType,
      connector: type.connector,
      area: pickArea(type),
      level: type.level,
      canonical: type.canonical,
      start: null,
      end: date,
      kind: "course",
    });
  }
  // Most recent first: sort by end (ongoing first), then start.
  const key = (s: Study) => (s.end === null ? 999999 : s.end.year * 12 + s.end.month);
  studies.push(...[...later, first0].sort((a, b) => key(b) - key(a)));

  // --- Skills and languages --------------------------------------------------------------------
  const skills = rng.sample(data.skills, options.skills);
  const languages: SpokenLanguage[] = [{ language: "Español", fluency: "Nativo" }];
  languages.push({ language: "Inglés", fluency: rng.pick(FLUENCY_OTHER) });
  if (rng.chance(0.45)) {
    languages.push({
      language: rng.pick(EXTRA_LANGUAGES[country]),
      fluency: rng.pick(["Básico", "Intermedio", "A2", "B1"]),
    });
  }

  const label = data.label[gender];
  const years = Math.max(1, monthsBetween(firstJobStart, REFERENCE) / 12) | 0;
  const summary = data.summary.replace("{label}", label).replace("{y}", String(years));

  return {
    country,
    gender,
    role,
    firstNames,
    lastNames,
    name,
    label,
    email,
    phone,
    city: place.city,
    region: place.region,
    countryName: COUNTRY_NAMES[country],
    summary,
    jobs,
    studies,
    skills,
    languages,
  };
}
