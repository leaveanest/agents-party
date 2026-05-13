import {
  type GenerateProps,
  type Plugins,
  type Template,
  checkInputs,
  checkTemplate,
} from "@pdfme/common";
import { generate } from "@pdfme/generator";
import {
  barcodes,
  checkbox,
  date,
  dateTime,
  ellipse,
  image,
  line,
  list,
  radioGroup,
  rectangle,
  select,
  signature,
  svg,
  table,
  text,
  time,
} from "@pdfme/schemas";
import { z } from "zod";

import { salesforcePdfWorkflowActionSchema } from "../../domain/salesforcePdfWorkflows.js";

export const pdfTemplateDefinitionSchema = z.object({
  action: salesforcePdfWorkflowActionSchema,
  description: z.string().optional(),
  displayName: z.string().trim().min(1),
  inputSchema: z.record(z.string(), z.custom<z.ZodType>(isZodSchema)).optional(),
  templateId: z.string().trim().min(1),
  version: z.string().trim().min(1),
});

export type PdfTemplateDefinition = z.infer<typeof pdfTemplateDefinitionSchema> & {
  template: Template;
};

export type PdfRenderInput = {
  input: Record<string, unknown>;
  templateId: string;
};

export type PdfRenderResult = {
  bytes: Uint8Array;
  template: PdfTemplateDefinition;
};

export type PdfTemplateInput = Record<string, string | string[][]>;

export class PdfGenerationError extends Error {
  readonly code:
    | "invalid_input"
    | "invalid_template"
    | "missing_template"
    | "render_failed"
    | "unsupported_schema";

  constructor(message: string, options: { code: PdfGenerationError["code"]; cause?: unknown }) {
    super(message);
    this.name = "PdfGenerationError";
    this.code = options.code;
    this.cause = options.cause;
  }
}

export type PdfTemplateRegistry = {
  findTemplate(templateId: string): Promise<PdfTemplateDefinition | undefined>;
};

export class InMemoryPdfTemplateRegistry implements PdfTemplateRegistry {
  private readonly templates: Map<string, PdfTemplateDefinition>;

  constructor(templates: readonly PdfTemplateDefinition[]) {
    this.templates = new Map(templates.map((template) => [template.templateId, template]));
  }

  async findTemplate(templateId: string): Promise<PdfTemplateDefinition | undefined> {
    return this.templates.get(templateId);
  }
}

export class PdfmeGenerationService {
  private readonly plugins: Plugins;
  private readonly registry: PdfTemplateRegistry;

  constructor(input: { plugins?: Plugins; registry: PdfTemplateRegistry }) {
    this.plugins = input.plugins ?? defaultPdfmePlugins();
    this.registry = input.registry;
  }

  async render(input: PdfRenderInput): Promise<PdfRenderResult> {
    const template = await this.registry.findTemplate(input.templateId);
    if (template === undefined) {
      throw new PdfGenerationError(`PDF template '${input.templateId}' was not found.`, {
        code: "missing_template",
      });
    }
    validateTemplateDefinition(template);
    validateTemplatePlugins(template.template, this.plugins);
    const parsedInput = validateTemplateInput(template, input.input);
    const props: GenerateProps = {
      inputs: [parsedInput],
      plugins: this.plugins,
      template: template.template,
    };
    try {
      try {
        checkInputs(props.inputs);
      } catch (error) {
        throw new PdfGenerationError("PDF template input is invalid.", {
          cause: error,
          code: "invalid_input",
        });
      }
      return {
        bytes: await generate(props),
        template,
      };
    } catch (error) {
      if (error instanceof PdfGenerationError) {
        throw error;
      }
      throw new PdfGenerationError("PDF rendering failed.", {
        cause: error,
        code: "render_failed",
      });
    }
  }
}

export function defaultPdfmePlugins(): Plugins {
  return {
    Checkbox: checkbox,
    Date: date,
    DateTime: dateTime,
    Ellipse: ellipse,
    Image: image,
    Line: line,
    List: list,
    QR: barcodes.qrcode,
    RadioGroup: radioGroup,
    Rectangle: rectangle,
    Select: select,
    Signature: signature,
    SVG: svg,
    Table: table,
    Text: text,
    Time: time,
  };
}

function validateTemplateDefinition(template: PdfTemplateDefinition): void {
  const parsed = pdfTemplateDefinitionSchema.safeParse(template);
  if (!parsed.success) {
    throw new PdfGenerationError("PDF template metadata is invalid.", {
      cause: parsed.error,
      code: "invalid_template",
    });
  }
  try {
    checkTemplate(template.template);
  } catch (error) {
    throw new PdfGenerationError("PDF template is invalid.", {
      cause: error,
      code: "invalid_template",
    });
  }
}

function validateTemplateInput(
  template: PdfTemplateDefinition,
  input: Record<string, unknown>,
): PdfTemplateInput {
  if (!isInputRecord(input)) {
    throw new PdfGenerationError("PDF template input must be an object.", {
      code: "invalid_input",
    });
  }
  if (template.inputSchema !== undefined) {
    const result = z.object(template.inputSchema).safeParse(input);
    if (!result.success) {
      throw new PdfGenerationError("PDF template input is invalid.", {
        cause: result.error,
        code: "invalid_input",
      });
    }
    return normalizePdfTemplateInput(template.template, result.data);
  }
  return normalizePdfTemplateInput(template.template, input);
}

export function normalizePdfTemplateInput(
  template: Template,
  input: Record<string, unknown>,
): PdfTemplateInput {
  const schemaFields = schemaFieldNames(template);
  const defaults = schemaDefaultContent(template);
  const output: PdfTemplateInput = {};
  for (const [field, value] of Object.entries(input)) {
    output[field] = normalizePdfInputValue(value);
  }
  for (const field of schemaFields) {
    if (Object.hasOwn(output, field)) {
      continue;
    }
    const value = input[field];
    output[field] =
      value === undefined || value === null ? (defaults.get(field) ?? "") : String(value);
  }
  return output;
}

export function validatePdfTemplateInput(
  template: PdfTemplateDefinition,
  input: Record<string, unknown>,
): PdfTemplateInput {
  return validateTemplateInput(template, input);
}

function normalizePdfInputValue(value: unknown): string | string[][] {
  if (typeof value === "string") {
    return value;
  }
  if (isStringTable(value)) {
    return value;
  }
  return value === undefined || value === null ? "" : String(value);
}

function validateTemplatePlugins(template: Template, plugins: Plugins): void {
  const pluginNames = new Set(Object.keys(plugins).map((name) => name.toLocaleLowerCase()));
  const unsupported = schemaTypes(template).filter(
    (type) => !pluginNames.has(type.toLocaleLowerCase()),
  );
  if (unsupported.length > 0) {
    throw new PdfGenerationError(`Unsupported PDF schema type: ${unsupported.join(", ")}`, {
      code: "unsupported_schema",
    });
  }
}

function schemaFieldNames(template: Template): string[] {
  return [
    ...new Set(
      allTemplateSchemas(template).flatMap((page) =>
        page.map((schema) => (typeof schema.name === "string" ? schema.name : "")).filter(Boolean),
      ),
    ),
  ];
}

function schemaDefaultContent(template: Template): Map<string, string> {
  return new Map(
    allTemplateSchemas(template).flatMap((page) =>
      page
        .map((schema) =>
          typeof schema.name === "string" && typeof schema.content === "string"
            ? ([schema.name, schema.content] as const)
            : undefined,
        )
        .filter((entry) => entry !== undefined),
    ),
  );
}

function schemaTypes(template: Template): string[] {
  return [
    ...new Set(
      allTemplateSchemas(template).flatMap((page) =>
        page.map((schema) => (typeof schema.type === "string" ? schema.type : "")).filter(Boolean),
      ),
    ),
  ];
}

function allTemplateSchemas(template: Template): Array<Array<Record<string, unknown>>> {
  const dynamicSchemas = Array.isArray(template.schemas)
    ? (template.schemas as Array<Array<Record<string, unknown>>>)
    : [];
  const basePdf = template.basePdf;
  const staticSchema =
    typeof basePdf === "object" &&
    basePdf !== null &&
    "staticSchema" in basePdf &&
    Array.isArray(basePdf.staticSchema)
      ? [basePdf.staticSchema as Array<Record<string, unknown>>]
      : [];
  return [...dynamicSchemas, ...staticSchema];
}

function isInputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

function isStringTable(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))
  );
}
