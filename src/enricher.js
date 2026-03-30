// enricher.js — витягує структуровані дані з тексту вакансії
// Аналізує title + description і добавляє: tech-теги, рівень, remote, досвід
// Використовується для відображення на картках і в аналітиці

// ─── Tech Stack словник ───────────────────────────────────────────
// Кожен запис: { tag, re } — короткий ярлик і regex для пошуку
const TECH_TAGS = [
  // Cloud
  { tag: 'AWS',            re: /\baws\b|\bamazon\s+web\s+services\b/i },
  { tag: 'GCP',            re: /\bgcp\b|\bgoogle\s+cloud\b/i },
  { tag: 'Azure',          re: /\bazure\b/i },
  // Containers
  { tag: 'Kubernetes',     re: /\bkubernetes\b|\bk8s\b/i },
  { tag: 'Docker',         re: /\bdocker\b/i },
  { tag: 'Helm',           re: /\bhelm\b/i },
  // IaC
  { tag: 'Terraform',      re: /\bterraform\b/i },
  { tag: 'Ansible',        re: /\bansible\b/i },
  { tag: 'Pulumi',         re: /\bpulumi\b/i },
  // CI/CD
  { tag: 'GitLab CI',      re: /\bgitlab\s*(ci)?\b/i },
  { tag: 'GitHub Actions', re: /\bgithub\s+actions\b/i },
  { tag: 'Jenkins',        re: /\bjenkins\b/i },
  { tag: 'ArgoCD',         re: /\bargoc?d\b/i },
  { tag: 'CI/CD',          re: /\bci[\/ ]cd\b/i },
  // Monitoring
  { tag: 'Prometheus',     re: /\bprometheus\b/i },
  { tag: 'Grafana',        re: /\bgrafana\b/i },
  { tag: 'ELK',            re: /\belk\b|\belastic\b|\bkibana\b/i },
  { tag: 'Datadog',        re: /\bdatadog\b/i },
  { tag: 'Loki',           re: /\bloki\b/i },
  // Languages
  { tag: 'Python',         re: /\bpython\b/i },
  { tag: 'Go',             re: /\bgolang\b|\bgo\b(?![\w-])/i },
  { tag: 'Bash',           re: /\bbash\b|\bshell\b/i },
  // Systems
  { tag: 'Linux',          re: /\blinux\b|\bubuntu\b|\bdebian\b|\bcentos\b|\brhel\b/i },
  { tag: 'Nginx',          re: /\bnginx\b/i },
  { tag: 'PostgreSQL',     re: /\bpostgresql\b|\bpostgres\b/i },
  // Networking / Security
  { tag: 'Vault',          re: /\bhashicorp\s+vault\b|\bvault\b/i },
  { tag: 'Istio',          re: /\bistio\b/i },
  // Infra
  { tag: 'MLOps',          re: /\bmlops\b/i },
];

// ─── Рівень досвіду ──────────────────────────────────────────────
const LEVELS = [
  { key: 'intern',   label: 'Intern',   re: /\b(intern|trainee|стажер)\b/i,                  cls: 'level-intern'  },
  { key: 'junior',   label: 'Junior',   re: /\b(junior|джуніор|jr\.?)\b/i,                   cls: 'level-junior'  },
  { key: 'middle',   label: 'Middle',   re: /\b(middle|mid\.?|міддл)\b/i,                    cls: 'level-middle'  },
  { key: 'senior',   label: 'Senior',   re: /\b(senior|sr\.?|сеніор)\b/i,                    cls: 'level-senior'  },
  { key: 'lead',     label: 'Lead',     re: /\b(lead|tech\.?\s*lead|team\.?\s*lead)\b/i,     cls: 'level-lead'    },
  { key: 'staff',    label: 'Staff',    re: /\b(staff|principal|architect)\b/i,               cls: 'level-staff'   },
];

// ─── Remote / формат роботи ──────────────────────────────────────
const WORK_FORMATS = [
  { key: 'remote',  label: 'Remote',   re: /\b(remote|remote.first|fully\s+remote|віддален|удален)\b/i },
  { key: 'hybrid',  label: 'Hybrid',   re: /\b(hybrid|гібрид|part.?time\s+remote)\b/i                 },
  { key: 'office',  label: 'Office',   re: /\b(office.?only|в\s+офіс|в\s+офис|office-based)\b/i      },
];

// ─── Кількість років досвіду ─────────────────────────────────────
// "3+ years", "2-4 роки", "від 3 років" тощо
const EXP_RE = /(\d+)\s*[\+\-–—]\s*\d*\s*(?:years?|роки?|лет|р\.|yr)/i;
const EXP_MIN_RE = /(\d+)\+?\s*(?:years?|роки?|лет|р\.|yr)/i;

// ─── Основна функція збагачення ──────────────────────────────────

function enrichVacancy(v) {
  const text = `${v.title || ''} ${v.description || ''}`;
  const textLow = text.toLowerCase();

  // 1. Технологічні теги (максимум 6 для відображення)
  const techTags = TECH_TAGS
    .filter(t => t.re.test(text))
    .map(t => t.tag)
    .slice(0, 6);

  // 2. Рівень досвіду
  let level = null;
  for (const l of LEVELS) {
    if (l.re.test(v.title || '')) { // шукаємо спочатку в назві
      level = l;
      break;
    }
  }

  // 3. Формат роботи
  let workFormat = null;
  for (const f of WORK_FORMATS) {
    if (f.re.test(text)) {
      workFormat = f;
      break;
    }
  }

  // 4. Мінімальний досвід у роках
  let expYears = null;
  const expMatch = text.match(EXP_RE) || text.match(EXP_MIN_RE);
  if (expMatch) {
    expYears = parseInt(expMatch[1]);
    if (expYears > 20) expYears = null; // фільтруємо невалідні числа
  }

  // 5. Чи вказана зарплата
  const hasSalary = !!v.salary;

  // 6. "Свіжість" вакансії (днів тому)
  let daysOld = null;
  const dateStr = v.published_at || v.created_at?.slice(0, 10);
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d)) daysOld = Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  return {
    ...v,
    techTags,
    level,
    workFormat,
    expYears,
    hasSalary,
    daysOld,
  };
}

// Збагатити масив вакансій
function enrichAll(vacancies) {
  return vacancies.map(enrichVacancy);
}

module.exports = { enrichVacancy, enrichAll, TECH_TAGS, LEVELS };
