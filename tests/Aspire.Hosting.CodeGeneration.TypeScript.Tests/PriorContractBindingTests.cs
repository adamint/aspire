// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text.RegularExpressions;
using Aspire.TypeSystem;

namespace Aspire.Hosting.CodeGeneration.TypeScript.Tests;

/// <summary>
/// Guards the one compatibility property that keeps TypeScript generation working on a CLI older
/// than the SDK package that carries this generator.
/// </summary>
/// <remarks>
/// <para>
/// <c>Aspire.TypeSystem</c> is force-shared from the apphost server's default load context and
/// freezes its <c>AssemblyVersion</c> at <c>13.4.5.0</c>, so an already-shipped CLI binds a newer
/// SDK's <c>Aspire.Hosting.CodeGeneration.TypeScript</c> against the CLI's own, older copy of the
/// contract. Anything this assembly names that the older copy lacks fails at run time, and where it
/// fails depends on where it is named: a missing type in a type's interface list or signatures drops
/// only that type (<c>CodeGeneratorResolver</c> salvages the rest), while a missing member in a
/// method body throws <see cref="MissingMethodException"/> when the JIT compiles that method — which
/// on the generation path means TypeScript generation stops working, not just export.
/// </para>
/// <para>
/// The checked-in <c>src/Aspire.TypeSystem/api/Aspire.TypeSystem.cs</c> reference surface is the
/// repository's record of what has shipped, so it is used here as the definition of "members an
/// already-shipped CLI is guaranteed to have".
/// </para>
/// </remarks>
public partial class PriorContractBindingTests
{
    /// <summary>
    /// Types allowed to name post-baseline <c>Aspire.TypeSystem</c> API, and why.
    /// </summary>
    private static readonly Dictionary<string, string> s_allowedTypes = new(StringComparer.Ordinal)
    {
        [nameof(AtsTypeScriptApiReferenceExporter)] =
            "export lives on its own type precisely so an older CLI drops this type and keeps the code generator",
        [nameof(AtsContextCompatibility)] =
            "the single guarded read, kept behind a runtime probe in a method the JIT may not inline",
    };

    [Fact]
    public void GeneratorPathDoesNotBindTypeSystemMembersOutsideTheShippedBaseline()
    {
        var shippedNames = ReadShippedTypeSystemIdentifiers();

        var offenders = GetTypeSystemMemberReferencesByDeclaringType()
            .SelectMany(entry => entry.Value.Select(reference => (Type: entry.Key, Reference: reference)))
            .Where(candidate => !s_allowedTypes.ContainsKey(candidate.Type))
            .Where(candidate => IsPostBaseline(candidate.Reference, shippedNames))
            .Select(candidate => $"{candidate.Type} -> {candidate.Reference.DeclaringType}.{candidate.Reference.MemberName}")
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Empty(offenders);
    }

    [Fact]
    public void CompatibilityShimKeepsThePostBaselineReadOutOfLine()
    {
        // Inlining the read into its caller would put the member reference back on a method the
        // generation path always runs, undoing the probe.
        var read = typeof(AtsContextCompatibility).GetMethod(
            "ReadCapabilityExportingAssemblyName",
            BindingFlags.NonPublic | BindingFlags.Static);

        Assert.NotNull(read);
        Assert.Equal(MethodImplAttributes.NoInlining, read.MethodImplementationFlags & MethodImplAttributes.NoInlining);
    }

    [Fact]
    public void CompatibilityShimReadsTheMapWhenTheLoadedContractHasIt()
    {
        // The tests run against the in-repo contract, which does expose the map, so this pins that
        // the probe has not degraded the current-CLI path into the fallback.
        var context = new AtsContext
        {
            Capabilities = [],
            HandleTypes = [],
            DtoTypes = [],
            EnumTypes = [],
            CapabilityExportingAssemblyNames = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Contoso.Widgets/addWidget"] = "Contoso.Widgets.Hosting"
            }
        };

        Assert.True(AtsContextCompatibility.TryGetCapabilityExportingAssemblyName(context, "Contoso.Widgets/addWidget", out var owner));
        Assert.Equal("Contoso.Widgets.Hosting", owner);

        Assert.False(AtsContextCompatibility.TryGetCapabilityExportingAssemblyName(context, "Contoso.Widgets/addOther", out var missing));
        Assert.Null(missing);
    }

    private static bool IsPostBaseline(TypeSystemMemberReference reference, HashSet<string> shippedNames)
    {
        if (!shippedNames.Contains(reference.DeclaringType))
        {
            return true;
        }

        // Accessors carry the property name the baseline declares; constructors have no name to
        // match, and overload-level checking is out of scope for a name-based comparison.
        var memberName = reference.MemberName switch
        {
            ".ctor" or ".cctor" => null,
            ['g', 'e', 't', '_', .. var property] => property,
            ['s', 'e', 't', '_', .. var property] => property,
            var other => other,
        };

        return memberName is not null && !shippedNames.Contains(memberName);
    }

    private static HashSet<string> ReadShippedTypeSystemIdentifiers()
    {
        // Copied next to the test binary by the project file so this works from any working
        // directory, including Helix.
        var baselinePath = Path.Combine(AppContext.BaseDirectory, "ApiBaseline", "Aspire.TypeSystem.cs");
        Assert.True(File.Exists(baselinePath), $"Missing shipped API baseline at '{baselinePath}'.");

        return IdentifierRegex()
            .Matches(File.ReadAllText(baselinePath))
            .Select(match => match.Value)
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>
    /// Collects, per declaring type, the <c>Aspire.TypeSystem</c> members that the generator
    /// assembly's method bodies name.
    /// </summary>
    /// <remarks>
    /// Method bodies are read rather than reflected over because the question is what the IL binds
    /// to, not what the current contract happens to resolve. Nested types (including compiler
    /// generated closures) are attributed to their outermost declaring type so a lambda cannot
    /// smuggle a reference past the allow-list.
    /// </remarks>
    private static Dictionary<string, List<TypeSystemMemberReference>> GetTypeSystemMemberReferencesByDeclaringType()
    {
        var assemblyPath = typeof(AtsTypeScriptCodeGenerator).Assembly.Location;
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();

        var references = new Dictionary<string, List<TypeSystemMemberReference>>(StringComparer.Ordinal);

        foreach (var typeHandle in reader.TypeDefinitions)
        {
            var typeDefinition = reader.GetTypeDefinition(typeHandle);
            var owningTypeName = GetOutermostTypeName(reader, typeDefinition);

            foreach (var methodHandle in typeDefinition.GetMethods())
            {
                var method = reader.GetMethodDefinition(methodHandle);
                if (method.RelativeVirtualAddress == 0)
                {
                    continue;
                }

                var il = peReader.GetMethodBody(method.RelativeVirtualAddress).GetILBytes();
                if (il is null)
                {
                    continue;
                }

                foreach (var reference in ReadTypeSystemMemberReferences(reader, il))
                {
                    if (!references.TryGetValue(owningTypeName, out var list))
                    {
                        references[owningTypeName] = list = [];
                    }

                    list.Add(reference);
                }
            }
        }

        return references;
    }

    private static IEnumerable<TypeSystemMemberReference> ReadTypeSystemMemberReferences(MetadataReader reader, byte[] il)
    {
        var offset = 0;
        while (offset < il.Length)
        {
            OpCode opCode;
            if (il[offset] == 0xFE)
            {
                if (offset + 1 >= il.Length || s_twoByteOpCodes.Value[il[offset + 1]] is not { } prefixed)
                {
                    yield break;
                }

                opCode = prefixed;
                offset += 2;
            }
            else
            {
                if (s_oneByteOpCodes.Value[il[offset]] is not { } simple)
                {
                    yield break;
                }

                opCode = simple;
                offset += 1;
            }

            var operandSize = GetOperandSize(opCode, il, offset);
            if (opCode.OperandType is OperandType.InlineField or OperandType.InlineMethod or OperandType.InlineTok &&
                MetadataTokens.EntityHandle(BitConverter.ToInt32(il, offset)) is { Kind: HandleKind.MemberReference } handle)
            {
                var memberReference = reader.GetMemberReference((MemberReferenceHandle)handle);
                if (memberReference.Parent.Kind == HandleKind.TypeReference)
                {
                    var parent = (TypeReferenceHandle)memberReference.Parent;
                    if (GetAssemblyName(reader, parent) == "Aspire.TypeSystem")
                    {
                        yield return new TypeSystemMemberReference(
                            reader.GetString(reader.GetTypeReference(parent).Name),
                            reader.GetString(memberReference.Name));
                    }
                }
            }

            offset += operandSize;
        }
    }

    private static int GetOperandSize(OpCode opCode, byte[] il, int operandOffset) => opCode.OperandType switch
    {
        OperandType.InlineNone => 0,
        OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
        OperandType.InlineVar => 2,
        OperandType.InlineI8 or OperandType.InlineR => 8,
        // A switch is a 4-byte case count followed by that many 4-byte targets.
        OperandType.InlineSwitch => 4 + (4 * BitConverter.ToInt32(il, operandOffset)),
        _ => 4,
    };

    private static string GetOutermostTypeName(MetadataReader reader, TypeDefinition typeDefinition)
    {
        while (typeDefinition.IsNested)
        {
            typeDefinition = reader.GetTypeDefinition(typeDefinition.GetDeclaringType());
        }

        return reader.GetString(typeDefinition.Name);
    }

    private static string GetAssemblyName(MetadataReader reader, EntityHandle handle) => handle.Kind switch
    {
        HandleKind.AssemblyReference => reader.GetString(reader.GetAssemblyReference((AssemblyReferenceHandle)handle).Name),
        HandleKind.TypeReference => GetAssemblyName(reader, reader.GetTypeReference((TypeReferenceHandle)handle).ResolutionScope),
        _ => string.Empty,
    };

    private static readonly Lazy<OpCode?[]> s_oneByteOpCodes = new(() => BuildOpCodeTable(twoByte: false));

    private static readonly Lazy<OpCode?[]> s_twoByteOpCodes = new(() => BuildOpCodeTable(twoByte: true));

    private static OpCode?[] BuildOpCodeTable(bool twoByte)
    {
        var table = new OpCode?[0x100];
        foreach (var field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            if (field.GetValue(null) is not OpCode opCode)
            {
                continue;
            }

            var value = unchecked((ushort)opCode.Value);
            if (twoByte == value >= 0x100)
            {
                table[value & 0xFF] = opCode;
            }
        }

        return table;
    }

    [GeneratedRegex("[A-Za-z_][A-Za-z0-9_]*")]
    private static partial Regex IdentifierRegex();

    private readonly record struct TypeSystemMemberReference(string DeclaringType, string MemberName);
}
