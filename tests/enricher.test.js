// tests/enricher.test.js — тести для src/enricher.js

const { enrichVacancy } = require('../src/enricher');

// ─── Tech tags ────────────────────────────────────────────────────

describe('techTags', () => {
  test('виявляє AWS з тексту опису', () => {
    const v = enrichVacancy({ title: 'DevOps Engineer', description: 'Experience with AWS and Terraform required' });
    expect(v.techTags).toContain('AWS');
    expect(v.techTags).toContain('Terraform');
  });

  test('виявляє Kubernetes за псевдонімом k8s', () => {
    const v = enrichVacancy({ title: 'SRE', description: 'Manage k8s clusters and Docker containers' });
    expect(v.techTags).toContain('Kubernetes');
    expect(v.techTags).toContain('Docker');
  });

  test('максимум 6 тегів', () => {
    const desc = 'AWS GCP Azure Kubernetes Docker Helm Terraform Ansible Jenkins ArgoCD Prometheus Grafana';
    const v = enrichVacancy({ title: '', description: desc });
    expect(v.techTags.length).toBeLessThanOrEqual(6);
  });

  test('порожній опис — немає тегів', () => {
    const v = enrichVacancy({ title: '', description: '' });
    expect(v.techTags).toEqual([]);
  });

  test('CI/CD виявляється в описі', () => {
    const v = enrichVacancy({ title: '', description: 'Build CI/CD pipelines with GitHub Actions' });
    expect(v.techTags).toContain('GitHub Actions');
  });
});

// ─── Level detection ──────────────────────────────────────────────

describe('level', () => {
  test('Senior в заголовку', () => {
    const v = enrichVacancy({ title: 'Senior DevOps Engineer', description: '' });
    expect(v.level?.key).toBe('senior');
  });

  test('Junior в заголовку', () => {
    const v = enrichVacancy({ title: 'Junior SRE', description: '' });
    expect(v.level?.key).toBe('junior');
  });

  test('Middle в заголовку', () => {
    const v = enrichVacancy({ title: 'Middle DevOps', description: '' });
    expect(v.level?.key).toBe('middle');
  });

  test('Lead в заголовку', () => {
    const v = enrichVacancy({ title: 'Tech Lead DevOps', description: '' });
    expect(v.level?.key).toBe('lead');
  });

  test('немає рівня — level is null', () => {
    const v = enrichVacancy({ title: 'DevOps Engineer', description: '' });
    expect(v.level).toBeNull();
  });
});

// ─── Work format ──────────────────────────────────────────────────

describe('workFormat', () => {
  test('Remote виявляється', () => {
    const v = enrichVacancy({ title: '', description: 'Full remote position available' });
    expect(v.workFormat?.key).toBe('remote');
  });

  test('Hybrid виявляється', () => {
    const v = enrichVacancy({ title: '', description: 'Hybrid work, 2 days office' });
    expect(v.workFormat?.key).toBe('hybrid');
  });

  test('Office виявляється', () => {
    const v = enrichVacancy({ title: '', description: 'Office-based position in Kyiv' });
    expect(v.workFormat?.key).toBe('office');
  });

  test('без формату — null', () => {
    const v = enrichVacancy({ title: 'DevOps Engineer', description: 'Great company' });
    expect(v.workFormat).toBeNull();
  });
});

// ─── Experience years ─────────────────────────────────────────────

describe('expYears', () => {
  test('виявляє "3+ years"', () => {
    const v = enrichVacancy({ title: '', description: 'Minimum 3+ years of experience' });
    expect(v.expYears).toBe(3);
  });

  test('виявляє "2 роки"', () => {
    const v = enrichVacancy({ title: '', description: 'від 2 роки досвіду' });
    expect(v.expYears).toBe(2);
  });

  test('ігнорує нереальні числа > 20', () => {
    const v = enrichVacancy({ title: '', description: '100+ years experience' });
    expect(v.expYears).toBeNull();
  });
});

// ─── Salary / daysOld ─────────────────────────────────────────────

describe('hasSalary і daysOld', () => {
  test('hasSalary true коли є зарплата', () => {
    const v = enrichVacancy({ title: '', description: '', salary: '$3000-4000' });
    expect(v.hasSalary).toBe(true);
  });

  test('hasSalary false коли немає', () => {
    const v = enrichVacancy({ title: '', description: '', salary: null });
    expect(v.hasSalary).toBe(false);
  });

  test('daysOld розраховується для сьогоднішньої дати', () => {
    const today = new Date().toISOString().slice(0, 10);
    const v = enrichVacancy({ title: '', description: '', published_at: today });
    expect(v.daysOld).toBe(0);
  });

  test('daysOld розраховується для вчорашньої дати', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const v = enrichVacancy({ title: '', description: '', published_at: yesterday });
    expect(v.daysOld).toBe(1);
  });
});
