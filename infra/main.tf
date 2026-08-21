# Azure Static Web Apps host for the Horde Drafter site, in Terraform.
#
# Same target as infra/main.bicep (a static-site host on Azure's free tier),
# provided in both languages because Terraform and Bicep are the two IaC tools
# worth knowing on Azure and the choice is usually the team's, not the project's.
#
#   terraform -chdir=infra init
#   terraform -chdir=infra apply -var 'site_name=horde-drafter'

terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
  }
}

provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "horde" {
  name     = var.resource_group
  location = var.location
}

resource "azurerm_static_web_app" "horde" {
  name                = var.site_name
  resource_group_name = azurerm_resource_group.horde.name
  location            = azurerm_resource_group.horde.location
  sku_tier            = "Free"
  sku_size            = "Free"
}

output "default_host_name" {
  description = "The *.azurestaticapps.net host the site is served from."
  value       = azurerm_static_web_app.horde.default_host_name
}
