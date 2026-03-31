// keywords.js — shared keyword database for resume scoring and analysis
// Used server-side (scoring) and mirrored client-side (resume-editor.ejs)

const KW_DB = {
  'Контейнеризація': [
    'Docker','docker-compose','Docker Compose','Docker Swarm','Podman','containerd','OCI',
  ],
  'Оркестрація': [
    'Kubernetes','K8s','Helm','OpenShift','Rancher','EKS','GKE','AKS','KIND','k3s','Minikube',
  ],
  'CI/CD': [
    'Jenkins','GitLab CI','GitHub Actions','CircleCI','ArgoCD','Argo CD','FluxCD','Flux',
    'Tekton','TeamCity','Bamboo','Travis CI','Drone CI','Spinnaker','Concourse',
  ],
  'IaC': [
    'Terraform','Ansible','Puppet','Chef','Pulumi','CloudFormation','Bicep','Vagrant',
    'Packer','SaltStack','CDK',
  ],
  'Хмара': [
    'AWS','GCP','Azure','DigitalOcean','Hetzner','Linode','Cloudflare',
    'S3','EC2','Lambda','ECS','RDS','VPC','IAM','Route53','CloudFront',
    'Cloud Run','BigQuery',
  ],
  'Моніторинг та логи': [
    'Prometheus','Grafana','Loki','Alertmanager','Datadog','New Relic','Zabbix',
    'Nagios','Elasticsearch','Kibana','Logstash','ELK','Jaeger','OpenTelemetry',
    'Fluentd','Promtail','cAdvisor','VictoriaMetrics','InfluxDB',
  ],
  'Мережа та проксі': [
    'Nginx','HAProxy','Traefik','Istio','Envoy','Consul','VPN','DNS',
    'SSL/TLS','Ingress','Service Mesh','Vault',
  ],
  'Мови та скрипти': [
    'Python','Bash','Shell','Go','Golang','JavaScript','TypeScript','Ruby',
    'PowerShell','Groovy','YAML','HCL','Makefile',
  ],
  'Бази даних': [
    'PostgreSQL','MySQL','MariaDB','MongoDB','Redis','Elasticsearch',
    'ClickHouse','Kafka','RabbitMQ','NATS','Cassandra','SQLite',
  ],
  'Безпека': [
    'Trivy','SonarQube','SAST','DAST','HashiCorp Vault','RBAC','DevSecOps',
    'CIS','OWASP','Snyk','Falco','OPA','Cosign','SBOM',
  ],
  'Практики': [
    'CI/CD','GitOps','IaC','DevSecOps','SRE','Agile','Scrum','Kanban',
    'Blue-Green','Canary','Zero Downtime','High Availability','microservices',
    'Disaster Recovery','observability',
  ],
  'Git та VCS': [
    'Git','GitHub','GitLab','Bitbucket','Git Flow','trunk-based','monorepo',
  ],
  'Linux': [
    'Linux','Ubuntu','CentOS','Debian','RHEL','Alpine','systemd','cron','iptables',
    'SELinux','AppArmor',
  ],
  'Сертифікати': [
    'CKA','CKAD','CKS','AWS Solutions Architect','AWS DevOps','GCP Associate',
    'Azure Fundamentals','HashiCorp Certified',
  ],
};

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Calculate resume match score against vacancy text.
 * @param {string} vacancyText - vacancy title + description
 * @param {string} resumeText  - LaTeX resume code
 * @returns {{ score: number, matched: number, total: number, missing: string[] }}
 */
function calcScore(vacancyText, resumeText) {
  if (!vacancyText || !resumeText) return { score: 0, matched: 0, total: 0, missing: [] };

  let total   = 0;
  let matched = 0;
  const missing = [];

  for (const keywords of Object.values(KW_DB)) {
    for (const kw of keywords) {
      const rx = new RegExp('(?<![\\w-])' + escapeRx(kw) + '(?![\\w-])', 'i');
      if (rx.test(vacancyText)) {
        total++;
        if (rx.test(resumeText)) {
          matched++;
        } else {
          missing.push(kw);
        }
      }
    }
  }

  const score = total > 0 ? Math.round((matched / total) * 100) : 0;
  return { score, matched, total, missing };
}

module.exports = { KW_DB, calcScore };
