# infra/: Azure deployment as code

The Horde Drafter site is hosted on **GitHub Pages**. This directory is an
optional, infrastructure-as-code path to also host it on **Azure Static Web
Apps**, written twice so either IaC tool can drive it:

| File | Tool | What it provisions |
|------|------|--------------------|
| `main.bicep` | Bicep | A `Microsoft.Web/staticSites` resource (Free SKU) |
| `main.tf`, `variables.tf` | Terraform (azurerm) | A resource group + `azurerm_static_web_app` (Free SKU) |

Neither is required to run or serve the site. It stays plain HTML/CSS/JS with
no build step. This is here so an Azure deployment is reproducible from source
rather than clicked together in the portal.

## Bicep

```bash
az group create -n horde-rg -l eastasia
az deployment group create -g horde-rg -f infra/main.bicep -p siteName=horde-drafter
```

## Terraform

```bash
terraform -chdir=infra init
terraform -chdir=infra plan
terraform -chdir=infra apply -var 'site_name=horde-drafter'
```

## Publishing content

Both create an empty Static Web App. To push the static files, use the
[Static Web Apps CLI](https://azure.github.io/static-web-apps-cli/) or the
`Azure/static-web-apps-deploy` GitHub Action with the deployment token from the
created resource. The CI workflow in `.github/workflows/ci.yml` validates these
templates on every push; it does not deploy them.
