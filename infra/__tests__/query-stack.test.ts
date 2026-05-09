/**
 * Query stack template assertions.
 *
 * Locks the Phase 7 architectural decisions in the synthesized CFN:
 *   - REST API (not HTTP API).
 *   - Read-only IAM grant on the readings table (no write actions).
 *   - Permissive CORS.
 *   - Lambda runtime + tracing + env vars.
 *   - GET /sensors/{sensorId}/readings route.
 */

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';
import { QueryStack } from '../lib/query-stack';

const synth = (): Template => {
  const app = new App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const projectName = 'gsp-test';
  const storage = new StorageStack(app, 'Storage', { env, projectName });
  const query = new QueryStack(app, 'Query', {
    env,
    projectName,
    readingsTable: storage.readingsTable,
  });
  return Template.fromStack(query);
};

describe('QueryStack template', () => {
  describe('REST API', () => {
    it('creates a REST API (not HTTP API)', () => {
      const template = synth();
      template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
      // HTTP API would be `AWS::ApiGatewayV2::Api`
      template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
    });

    it('has X-Ray tracing enabled on the deployment stage', () => {
      const template = synth();
      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        TracingEnabled: true,
      });
    });

    it('has access logging configured', () => {
      const template = synth();
      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        AccessLogSetting: Match.objectLike({
          DestinationArn: Match.anyValue(),
        }),
      });
    });
  });

  describe('Routes', () => {
    it('exposes GET /sensors/{sensorId}/readings', () => {
      const template = synth();
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'GET',
        RequestParameters: Match.objectLike({
          'method.request.path.sensorId': true,
        }),
      });
    });

    it('declares query string parameters as optional', () => {
      const template = synth();
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'GET',
        RequestParameters: Match.objectLike({
          'method.request.querystring.from': false,
          'method.request.querystring.to': false,
          'method.request.querystring.limit': false,
        }),
      });
    });
  });

  describe('CORS', () => {
    it('allows OPTIONS method (CORS preflight)', () => {
      const template = synth();
      // Each resource with CORS has its own OPTIONS method
      const methods = template.findResources('AWS::ApiGateway::Method');
      const optionsMethods = Object.values(methods).filter(
        (m) => (m as { Properties: { HttpMethod?: string } }).Properties.HttpMethod === 'OPTIONS',
      );
      expect(optionsMethods.length).toBeGreaterThan(0);
    });
  });

  describe('Query Lambda', () => {
    it('runs on Node 20 with X-Ray active', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
        TracingConfig: { Mode: 'Active' },
      });
    });

    it('has READINGS_TABLE env var injected', () => {
      const template = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            READINGS_TABLE: Match.anyValue(),
            POWERTOOLS_SERVICE_NAME: 'grid-sensor-query',
          }),
        },
      });
    });
  });

  describe('IAM (defense in depth)', () => {
    it('grants only read actions on the readings table — no writes', () => {
      const template = synth();
      const policies = template.findResources('AWS::IAM::Policy');
      const queryPolicies = Object.values(policies).filter((p) => {
        const statements = (
          p as {
            Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown }> } };
          }
        ).Properties.PolicyDocument.Statement;
        return statements.some((s) => {
          const action = s.Action;
          if (!action) return false;
          const actionStr = JSON.stringify(action);
          return actionStr.includes('dynamodb:GetItem') || actionStr.includes('dynamodb:Query');
        });
      });
      // Confirm at least one policy grants reads
      expect(queryPolicies.length).toBeGreaterThan(0);

      // Confirm no policy grants writes on DynamoDB
      for (const policy of Object.values(policies)) {
        const statements = (
          policy as {
            Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown }> } };
          }
        ).Properties.PolicyDocument.Statement;
        for (const stmt of statements) {
          const actionStr = JSON.stringify(stmt.Action ?? '');
          expect(actionStr).not.toContain('dynamodb:PutItem');
          expect(actionStr).not.toContain('dynamodb:UpdateItem');
          expect(actionStr).not.toContain('dynamodb:DeleteItem');
        }
      }
    });
  });

  describe('Stack outputs', () => {
    it('exports the API URL for portfolio embedding / verification', () => {
      const template = synth();
      template.hasOutput('QueryApiUrl', {});
    });
  });
});
