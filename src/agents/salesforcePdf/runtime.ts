import type { OAuthRepository } from "../../integrations/oauth/coordinators.js";
import { SalesforceAuthCoordinator } from "../../integrations/oauth/coordinators.js";
import { FernetTextCipher } from "../../integrations/oauth/fernet.js";
import { FetchSalesforceOAuthGateway } from "../../integrations/oauth/gateways.js";
import {
  InMemoryPdfTemplateRegistry,
  PdfmeGenerationService,
  createDefaultDealReviewPackTemplate,
  createDefaultQuotePdfTemplate,
} from "../../integrations/pdf/index.js";
import { SalesforceRestGateway } from "../../integrations/salesforce/index.js";
import {
  DealReviewPackWorkflow,
  type DealReviewPackWorkflowSettingsRepository,
  QuotePdfWorkflow,
  type QuotePdfWorkflowSettingsRepository,
  type SalesforcePdfToolOptions,
} from "./index.js";

export type SalesforcePdfWorkflowRuntimeRepository = DealReviewPackWorkflowSettingsRepository &
  QuotePdfWorkflowSettingsRepository;

export function createSalesforcePdfToolDependencies(input: {
  contextSigningSecret: string;
  oauthRepository: OAuthRepository;
  settingsRepository: SalesforcePdfWorkflowRuntimeRepository;
  tokenEncryptionKey: string;
}): Omit<SalesforcePdfToolOptions, "context"> {
  const tokenCipher = new FernetTextCipher(input.tokenEncryptionKey);
  const salesforceAuthCoordinator = new SalesforceAuthCoordinator({
    contextSigningSecret: input.contextSigningSecret,
    gateway: new FetchSalesforceOAuthGateway({ clientSecretCipher: tokenCipher }),
    repository: input.oauthRepository,
    tokenCipher,
  });
  const salesforce = new SalesforceRestGateway({
    connectionResolver: salesforceAuthCoordinator,
    tokenCipher,
  });
  const pdfRenderer = new PdfmeGenerationService({
    registry: new InMemoryPdfTemplateRegistry([
      createDefaultQuotePdfTemplate(),
      createDefaultDealReviewPackTemplate(),
    ]),
  });
  return {
    dealReviewPackWorkflow: new DealReviewPackWorkflow({
      pdfRenderer,
      salesforce,
      settingsRepository: input.settingsRepository,
    }),
    quotePdfWorkflow: new QuotePdfWorkflow({
      pdfRenderer,
      salesforce,
      settingsRepository: input.settingsRepository,
    }),
  };
}
