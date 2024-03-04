// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Concurrent;
using Aspire.Dashboard.Model;

namespace Aspire.Dashboard.Extensions;

internal static class ResourceExtensions
{
    public static IEnumerable<ResourceViewModelBase> MapResourceNamesToSets(ConcurrentDictionary<string, ResourceViewModel> resourceByName)
    {
        foreach (var resourceGroupsByApplicationName in resourceByName.Values.OrderBy(c => c.Name).GroupBy(resource => resource.DisplayName))
        {
            if (resourceGroupsByApplicationName.Count() > 1)
            {
                yield return new ResourceSetViewModel(resourceGroupsByApplicationName.ToList())
                {
                    Name = resourceGroupsByApplicationName.Key
                };
            }
            else
            {
                foreach (var resource in resourceGroupsByApplicationName)
                {
                    yield return resource;
                }
            }
        }
    }
}
