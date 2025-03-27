@description('The location for the resource(s) to be deployed.')
param location string = resourceGroup().location

param servicebus_outputs_name string

param principalType string

param principalId string

resource servicebus 'Microsoft.ServiceBus/namespaces@2024-01-01' existing = {
  name: servicebus_outputs_name
}

resource servicebus_AzureServiceBusDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(servicebus.id, principalId, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '090c5cfd-751d-490a-894a-3ce6f1109419'))
  properties: {
    principalId: principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '090c5cfd-751d-490a-894a-3ce6f1109419')
    principalType: principalType
  }
  scope: servicebus
}