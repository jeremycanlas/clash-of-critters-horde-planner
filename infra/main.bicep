// Azure Static Web Apps host for the Horde Drafter site, as Bicep.
//
// The site is a static bundle (HTML/CSS/JS plus prebuilt JSON under data/), so
// Static Web Apps is the natural Azure home: no server to run, a global CDN,
// and a free tier that covers this traffic. GitHub Pages stays the primary
// host; this file is the infrastructure-as-code path for an Azure deployment,
// provisioned identically every time instead of clicked together in the portal.
//
// Deploy:
//   az group create -n horde-rg -l eastasia
//   az deployment group create -g horde-rg -f infra/main.bicep -p siteName=horde-drafter

@description('Name of the Static Web App resource.')
param siteName string = 'horde-drafter'

@description('Region for the Static Web App. Static Web Apps runs in a limited set of regions; East Asia is closest to the audience.')
@allowed([
  'eastasia'
  'centralus'
  'eastus2'
  'westeurope'
  'westus2'
])
param location string = 'eastasia'

@description('SKU tier. Free is enough for a static site with CDN.')
@allowed([
  'Free'
  'Standard'
])
param sku string = 'Free'

resource site 'Microsoft.Web/staticSites@2023-12-01' = {
  name: siteName
  location: location
  sku: {
    name: sku
    tier: sku
  }
  properties: {
    // The content is built in CI and uploaded, so no repository build config is
    // wired into the resource itself.
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
  }
}

output defaultHostname string = site.properties.defaultHostname
output siteName string = site.name
