﻿//------------------------------------------------------------------------------
// <auto-generated>
//     This code was generated by a tool.
//
//     Changes to this file may cause incorrect behavior and will be lost if
//     the code is regenerated.
// </auto-generated>
//------------------------------------------------------------------------------

namespace Aspire.Dashboard.Resources {
    using System;
    
    
    /// <summary>
    ///   A strongly-typed resource class, for looking up localized strings, etc.
    /// </summary>
    // This class was auto-generated by the StronglyTypedResourceBuilder
    // class via a tool like ResGen or Visual Studio.
    // To add or remove a member, edit your .ResX file then rerun ResGen
    // with the /str option, or rebuild your VS project.
    [global::System.CodeDom.Compiler.GeneratedCodeAttribute("System.Resources.Tools.StronglyTypedResourceBuilder", "17.0.0.0")]
    [global::System.Diagnostics.DebuggerNonUserCodeAttribute()]
    [global::System.Runtime.CompilerServices.CompilerGeneratedAttribute()]
    public class Metrics {
        
        private static global::System.Resources.ResourceManager resourceMan;
        
        private static global::System.Globalization.CultureInfo resourceCulture;
        
        [global::System.Diagnostics.CodeAnalysis.SuppressMessageAttribute("Microsoft.Performance", "CA1811:AvoidUncalledPrivateCode")]
        internal Metrics() {
        }
        
        /// <summary>
        ///   Returns the cached ResourceManager instance used by this class.
        /// </summary>
        [global::System.ComponentModel.EditorBrowsableAttribute(global::System.ComponentModel.EditorBrowsableState.Advanced)]
        public static global::System.Resources.ResourceManager ResourceManager {
            get {
                if (object.ReferenceEquals(resourceMan, null)) {
                    global::System.Resources.ResourceManager temp = new global::System.Resources.ResourceManager("Aspire.Dashboard.Resources.Metrics", typeof(Metrics).Assembly);
                    resourceMan = temp;
                }
                return resourceMan;
            }
        }
        
        /// <summary>
        ///   Overrides the current thread's CurrentUICulture property for all
        ///   resource lookups using this strongly typed resource class.
        /// </summary>
        [global::System.ComponentModel.EditorBrowsableAttribute(global::System.ComponentModel.EditorBrowsableState.Advanced)]
        public static global::System.Globalization.CultureInfo Culture {
            get {
                return resourceCulture;
            }
            set {
                resourceCulture = value;
            }
        }
        
        /// <summary>
        ///   Looks up a localized string similar to Metrics.
        /// </summary>
        public static string MetricsHeader {
            get {
                return ResourceManager.GetString("MetricsHeader", resourceCulture);
            }
        }
        
        /// <summary>
        ///   Looks up a localized string similar to No metrics for the selected resource.
        /// </summary>
        public static string MetricsNoMetricsForResource {
            get {
                return ResourceManager.GetString("MetricsNoMetricsForResource", resourceCulture);
            }
        }
        
        /// <summary>
        ///   Looks up a localized string similar to {0} Metrics.
        /// </summary>
        public static string MetricsPageTitle {
            get {
                return ResourceManager.GetString("MetricsPageTitle", resourceCulture);
            }
        }
        
        /// <summary>
        ///   Looks up a localized string similar to Select a Duration.
        /// </summary>
        public static string MetricsSelectADuration {
            get {
                return ResourceManager.GetString("MetricsSelectADuration", resourceCulture);
            }
        }
        
        /// <summary>
        ///   Looks up a localized string similar to Select an Application.
        /// </summary>
        public static string MetricsSelectAnApplication {
            get {
                return ResourceManager.GetString("MetricsSelectAnApplication", resourceCulture);
            }
        }
        
        /// <summary>
        ///   Looks up a localized string similar to Select a resource to view metrics.
        /// </summary>
        public static string MetricsSelectAResource {
            get {
                return ResourceManager.GetString("MetricsSelectAResource", resourceCulture);
            }
        }
        
        /// <summary>
        ///   Looks up a localized string similar to Select instrument..
        /// </summary>
        public static string MetricsSelectInstrument {
            get {
                return ResourceManager.GetString("MetricsSelectInstrument", resourceCulture);
            }
        }
    }
}
