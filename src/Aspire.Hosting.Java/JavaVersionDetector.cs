// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Aspire.Hosting.Java;

/// <summary>
/// Determines which Java release a project targets, so the generated container image builds and runs it
/// on a matching JDK and JRE.
/// </summary>
/// <remarks>
/// Detection is best effort and never fails: an unreadable or unrecognised build file falls back to
/// <see cref="DefaultJavaVersion"/>. Callers can always override the images with
/// <c>WithDockerfileBaseImages</c>.
/// </remarks>
internal static partial class JavaVersionDetector
{
    /// <summary>
    /// The Java release used when a project's build files declare none. Chosen as the newest long-term
    /// support release, which is what current Spring Boot and Quarkus releases target by default.
    /// </summary>
    internal const string DefaultJavaVersion = "21";

    public static string Detect(string appDirectory)
    {
        return DetectFromPom(Path.Combine(appDirectory, "pom.xml"))
            ?? DetectFromGradle(Path.Combine(appDirectory, "build.gradle"))
            ?? DetectFromGradle(Path.Combine(appDirectory, "build.gradle.kts"))
            ?? DefaultJavaVersion;
    }

    /// <summary>
    /// Reads the target release from a Maven POM.
    /// </summary>
    /// <remarks>
    /// Three spellings are common and all appear in Spring Initializr output:
    /// <code language="xml">
    /// &lt;properties&gt;
    ///   &lt;java.version&gt;21&lt;/java.version&gt;
    ///   &lt;maven.compiler.release&gt;21&lt;/maven.compiler.release&gt;
    /// &lt;/properties&gt;
    /// &lt;!-- or, on the compiler plugin itself --&gt;
    /// &lt;configuration&gt;&lt;release&gt;21&lt;/release&gt;&lt;/configuration&gt;
    /// </code>
    /// Legacy POMs write <c>1.8</c> rather than <c>8</c>; both map to the <c>8</c> image tag.
    /// Property references such as <c>&lt;release&gt;${java.version}&lt;/release&gt;</c> are not expanded —
    /// the literal properties are checked first, so the reference is only reached when nothing else matched.
    /// </remarks>
    private static string? DetectFromPom(string pomPath)
    {
        if (!File.Exists(pomPath))
        {
            return null;
        }

        XDocument document;
        try
        {
            document = XDocument.Load(pomPath);
        }
        catch (Exception ex) when (ex is System.Xml.XmlException or IOException or UnauthorizedAccessException)
        {
            // A malformed or unreadable POM is the build tool's problem to report, not a reason to fail
            // publishing before the container build has even started.
            return null;
        }

        // Element names are matched without their namespace so both the Maven 4 POM namespace and the
        // long-standing http://maven.apache.org/POM/4.0.0 namespace are handled.
        foreach (var name in (string[])["java.version", "maven.compiler.release", "maven.compiler.target", "release", "target"])
        {
            var value = document.Descendants()
                .FirstOrDefault(e => string.Equals(e.Name.LocalName, name, StringComparison.Ordinal))
                ?.Value;

            if (Normalize(value) is { } version)
            {
                return version;
            }
        }

        return null;
    }

    /// <summary>
    /// Reads the target release from a Gradle build script.
    /// </summary>
    /// <remarks>
    /// Groovy and Kotlin DSL spellings that appear in Spring Initializr and Gradle's own documentation:
    /// <code>
    /// java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
    /// java.sourceCompatibility = JavaVersion.VERSION_21
    /// sourceCompatibility = '17'
    /// targetCompatibility = 1.8
    /// </code>
    /// The toolchain is checked first because it pins the JDK Gradle actually compiles with, whereas
    /// source/target compatibility only constrain the bytecode level.
    /// </remarks>
    private static string? DetectFromGradle(string buildScriptPath)
    {
        if (!File.Exists(buildScriptPath))
        {
            return null;
        }

        string contents;
        try
        {
            contents = File.ReadAllText(buildScriptPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        if (ToolchainRegex().Match(contents) is { Success: true } toolchain)
        {
            return Normalize(toolchain.Groups[1].Value);
        }

        if (JavaVersionEnumRegex().Match(contents) is { Success: true } enumMatch)
        {
            return Normalize(enumMatch.Groups[1].Value.Replace('_', '.'));
        }

        if (CompatibilityRegex().Match(contents) is { Success: true } compatibility)
        {
            return Normalize(compatibility.Groups[1].Value);
        }

        return null;
    }

    /// <summary>
    /// Maps a declared release to the numeric form used in container image tags.
    /// </summary>
    /// <remarks>
    /// Java 8 and earlier are written <c>1.8</c> in build files but tagged <c>8</c> in images
    /// (<c>eclipse-temurin:8-jre</c>). Anything that is not a plain release number is rejected so a
    /// property reference such as <c>${java.version}</c> cannot end up inside a <c>FROM</c> instruction.
    /// </remarks>
    private static string? Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        value = value.Trim();

        if (value.StartsWith("1.", StringComparison.Ordinal))
        {
            value = value[2..];
        }

        return value.Length > 0 && value.All(char.IsAsciiDigit) ? value : null;
    }

    // Matches: languageVersion = JavaLanguageVersion.of(21)  and  languageVersion.set(JavaLanguageVersion.of(21))
    [GeneratedRegex(@"JavaLanguageVersion\.of\(\s*(\d+)\s*\)")]
    private static partial Regex ToolchainRegex();

    // Matches: sourceCompatibility = JavaVersion.VERSION_21  and  VERSION_1_8
    [GeneratedRegex(@"JavaVersion\.VERSION_(\d+(?:_\d+)?)")]
    private static partial Regex JavaVersionEnumRegex();

    // Matches: sourceCompatibility = '17'   targetCompatibility = 17   sourceCompatibility = "1.8"
    [GeneratedRegex(@"(?:source|target)Compatibility\s*(?:=|\.set\()\s*['""]?(\d+(?:\.\d+)?)['""]?")]
    private static partial Regex CompatibilityRegex();
}
