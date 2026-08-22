variable "site_name" {
  description = "Name of the Static Web App resource."
  type        = string
  default     = "horde-drafter"
}

variable "resource_group" {
  description = "Resource group that holds the site."
  type        = string
  default     = "horde-rg"
}

variable "location" {
  description = "Azure region. Must be a Static Web Apps region (e.g. East Asia, West Europe, Central US)."
  type        = string
  default     = "East Asia"
}
