// tests/utils.test.js — тести для src/scrapers/utils.js

const { isDevOpsTitle, cleanText } = require('../src/scrapers/utils');

// ─── isDevOpsTitle ────────────────────────────────────────────────

describe('isDevOpsTitle — дозволяє DevOps ролі', () => {
  const devopsPositive = [
    'DevOps Engineer',
    'Senior DevOps',
    'DevOps / SRE',
    'Site Reliability Engineer',
    'SRE Lead',
    'DevSecOps Engineer',
    'Cloud Engineer',
    'Platform Engineer',
    'Infrastructure Engineer',
    'MLOps Engineer',
    'CI/CD Engineer',
  ];

  devopsPositive.forEach(title => {
    test(`✓ "${title}"`, () => {
      expect(isDevOpsTitle(title)).toBe(true);
    });
  });
});

describe('isDevOpsTitle — відхиляє нерелевантні ролі', () => {
  const nonDevops = [
    'Java Developer',
    'Python Developer',
    'React Developer',
    'Frontend Developer',
    'Backend Developer',
    'Full Stack Developer',
    'QA Engineer',
    'Manual QA',
    'System Administrator',
    'Windows Administrator',
    'Product Manager',
    'Data Scientist',
    'Data Analyst',
    'Recruiter',
  ];

  nonDevops.forEach(title => {
    test(`✗ "${title}"`, () => {
      expect(isDevOpsTitle(title)).toBe(false);
    });
  });
});

// ─── cleanText ────────────────────────────────────────────────────

describe('cleanText', () => {
  test('прибирає зайві пробіли', () => {
    expect(cleanText('  hello   world  ')).toBe('hello world');
  });

  test('прибирає переноси рядків', () => {
    expect(cleanText('line1\n  line2')).toBe('line1 line2');
  });

  test('порожній рядок', () => {
    expect(cleanText('')).toBe('');
  });

  test('null → порожній рядок', () => {
    expect(cleanText(null)).toBe('');
  });
});
