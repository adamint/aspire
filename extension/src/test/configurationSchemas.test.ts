import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('configuration schema tests', () => {
    test('committed schemas include the default NuGet source', () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const schemaFiles = [
            'aspire-config.schema.json',
            'aspire-settings.schema.json',
            'aspire-global-settings.schema.json',
        ];

        for (const schemaFile of schemaFiles) {
            const schemaPath = path.join(extensionRoot, 'schemas', schemaFile);
            const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
                properties?: Record<string, { type?: string; description?: string }>;
            };
            const nugetSource = schema.properties?.nugetSource;

            assert.ok(nugetSource, `${schemaFile} should include nugetSource.`);
            assert.strictEqual(nugetSource.type, 'string');
            assert.match(nugetSource.description ?? '', /NuGet source/);
        }
    });
});
