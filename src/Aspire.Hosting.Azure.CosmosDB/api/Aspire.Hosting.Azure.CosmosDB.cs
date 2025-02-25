//------------------------------------------------------------------------------
// <auto-generated>
//     This code was generated by a tool.
//
//     Changes to this file may cause incorrect behavior and will be lost if
//     the code is regenerated.
// </auto-generated>
//------------------------------------------------------------------------------
namespace Aspire.Hosting
{
    public partial class AzureCosmosDBResource : Azure.AzureProvisioningResource, ApplicationModel.IResourceWithConnectionString, ApplicationModel.IResource, ApplicationModel.IManifestExpressionProvider, ApplicationModel.IValueProvider, ApplicationModel.IValueWithReferences, ApplicationModel.IResourceWithEndpoints, Azure.IResourceWithAzureFunctionsConfig
    {
        public AzureCosmosDBResource(string name, System.Action<Azure.AzureResourceInfrastructure> configureInfrastructure) : base(default!, default!) { }

        public Azure.BicepSecretOutputReference ConnectionString { get { throw null; } }

        public ApplicationModel.ReferenceExpression ConnectionStringExpression { get { throw null; } }

        public Azure.BicepOutputReference ConnectionStringOutput { get { throw null; } }

        public bool IsEmulator { get { throw null; } }

        [System.Diagnostics.CodeAnalysis.MemberNotNullWhen(true, "ConnectionStringSecretOutput")]
        public bool UseAccessKeyAuthentication { get { throw null; } }

        void Azure.IResourceWithAzureFunctionsConfig.ApplyAzureFunctionsConfiguration(System.Collections.Generic.IDictionary<string, object> target, string connectionName) { }
    }

    public static partial class AzureCosmosExtensions
    {
        public static ApplicationModel.IResourceBuilder<AzureCosmosDBResource> AddAzureCosmosDB(this IDistributedApplicationBuilder builder, string name) { throw null; }

        public static ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBContainerResource> AddContainer(this ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBDatabaseResource> builder, string name, string partitionKeyPath, string? containerName = null) { throw null; }

        public static ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBDatabaseResource> AddCosmosDatabase(this ApplicationModel.IResourceBuilder<AzureCosmosDBResource> builder, string name, string? databaseName = null) { throw null; }

        [System.Obsolete("This method is obsolete because it has the wrong return type and will be removed in a future version. Use AddCosmosDatabase instead to add a Cosmos DB database.")]
        public static ApplicationModel.IResourceBuilder<AzureCosmosDBResource> AddDatabase(this ApplicationModel.IResourceBuilder<AzureCosmosDBResource> builder, string databaseName) { throw null; }

        public static ApplicationModel.IResourceBuilder<AzureCosmosDBResource> RunAsEmulator(this ApplicationModel.IResourceBuilder<AzureCosmosDBResource> builder, System.Action<ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBEmulatorResource>>? configureContainer = null) { throw null; }

        [System.Diagnostics.CodeAnalysis.Experimental("ASPIRECOSMOSDB001", UrlFormat = "https://aka.ms/dotnet/aspire/diagnostics#{0}")]
        public static ApplicationModel.IResourceBuilder<AzureCosmosDBResource> RunAsPreviewEmulator(this ApplicationModel.IResourceBuilder<AzureCosmosDBResource> builder, System.Action<ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBEmulatorResource>>? configureContainer = null) { throw null; }

        public static ApplicationModel.IResourceBuilder<AzureCosmosDBResource> WithAccessKeyAuthentication(this ApplicationModel.IResourceBuilder<AzureCosmosDBResource> builder) { throw null; }

        [System.Diagnostics.CodeAnalysis.Experimental("ASPIRECOSMOSDB001", UrlFormat = "https://aka.ms/dotnet/aspire/diagnostics#{0}")]
        public static ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBEmulatorResource> WithDataExplorer(this ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBEmulatorResource> builder, int? port = null) { throw null; }

        public static ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBEmulatorResource> WithDataVolume(this ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBEmulatorResource> builder, string? name = null) { throw null; }

        public static ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBEmulatorResource> WithGatewayPort(this ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBEmulatorResource> builder, int? port) { throw null; }

        public static ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBEmulatorResource> WithPartitionCount(this ApplicationModel.IResourceBuilder<Azure.AzureCosmosDBEmulatorResource> builder, int count) { throw null; }
    }
}

namespace Aspire.Hosting.Azure
{
    public partial class AzureCosmosDBContainerResource : ApplicationModel.Resource, ApplicationModel.IResourceWithParent<AzureCosmosDBDatabaseResource>, ApplicationModel.IResourceWithParent, ApplicationModel.IResource, ApplicationModel.IResourceWithConnectionString, ApplicationModel.IManifestExpressionProvider, ApplicationModel.IValueProvider, ApplicationModel.IValueWithReferences, IResourceWithAzureFunctionsConfig
    {
        public AzureCosmosDBContainerResource(string name, string containerName, string partitionKeyPath, AzureCosmosDBDatabaseResource parent) : base(default!) { }

        public ApplicationModel.ReferenceExpression ConnectionStringExpression { get { throw null; } }

        public string ContainerName { get { throw null; } set { } }

        public AzureCosmosDBDatabaseResource Parent { get { throw null; } }

        public string PartitionKeyPath { get { throw null; } set { } }

        void IResourceWithAzureFunctionsConfig.ApplyAzureFunctionsConfiguration(System.Collections.Generic.IDictionary<string, object> target, string connectionName) { }
    }

    public partial class AzureCosmosDBDatabaseResource : ApplicationModel.Resource, ApplicationModel.IResourceWithParent<AzureCosmosDBResource>, ApplicationModel.IResourceWithParent, ApplicationModel.IResource, ApplicationModel.IResourceWithConnectionString, ApplicationModel.IManifestExpressionProvider, ApplicationModel.IValueProvider, ApplicationModel.IValueWithReferences, IResourceWithAzureFunctionsConfig
    {
        public AzureCosmosDBDatabaseResource(string name, string databaseName, AzureCosmosDBResource parent) : base(default!) { }

        public ApplicationModel.ReferenceExpression ConnectionStringExpression { get { throw null; } }

        public string DatabaseName { get { throw null; } set { } }

        public AzureCosmosDBResource Parent { get { throw null; } }

        void IResourceWithAzureFunctionsConfig.ApplyAzureFunctionsConfiguration(System.Collections.Generic.IDictionary<string, object> target, string connectionName) { }
    }

    public partial class AzureCosmosDBEmulatorResource : ApplicationModel.ContainerResource, ApplicationModel.IResource
    {
        public AzureCosmosDBEmulatorResource(AzureCosmosDBResource innerResource) : base(default!, default) { }

        public override ApplicationModel.ResourceAnnotationCollection Annotations { get { throw null; } }
    }
}