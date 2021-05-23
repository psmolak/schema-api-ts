import {JSONSchema} from "json-schema-to-typescript";
import {OASParameter, OASPath, OASRef, OASRequestBody, OASResponse} from "../dist/oas";
import {OAS, OASOperation} from "./oas";

function capitilize(name: string): string {
  return name.substring(0, 1).toUpperCase() + name.substring(1);
}
function name(part: string) {
  return part.startsWith('{') ? ('By' + capitilize(part.substring(1, part.length - 1))) : capitilize(part);
}

function pathName(path: string) {
  return path.split('/').map(name).join('');
}

function traverse<T>(parts: string[], obj: any): T | undefined{
  if(obj && parts.length > 0 && typeof(obj) === 'object') {
    const nextKey = parts[0];
    if(Object.prototype.hasOwnProperty.call(obj, nextKey)) {
      const next = obj[nextKey];
      if (parts.length === 1) return next;
      else return traverse<T>(parts.slice(1), next);
    }
  }
  return undefined;
}

function traversePath<T>(path: string, obj: any): T {
  return traverse<T>(path.replace('#/', '').split('/'), obj) as T;
}

function pathsFrom(oas: OAS): Array<{path: string, definition: OASPath | undefined}> {
  return Object.keys(oas.paths).map(key => {
    const value = oas.paths[key];
    if(Object.prototype.hasOwnProperty.call(value, '$ref')) return { path: key, definition: traversePath((value as OASRef)['$ref'], oas)};
    return { path: key, definition: value as OASPath}
  })
}
function methodOperations(path: OASPath): Array<{method: string; definition: OASOperation}> {
  const keys = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
  return Object.keys(path).filter(it => keys.includes(it)).map(key => {
    const operation = (path as any)[key] as OASOperation;
    const definition: OASOperation = {...operation, parameters: [...(operation.parameters ?? []), ...(path.parameters ?? [])] }
    return {method: key, definition};
  });
}

function operationParameters(oas: OAS, operation: OASOperation): OASParameter[] {
  return (operation.parameters ?? []).map(it => {
    if(Object.prototype.hasOwnProperty.call(it, '$ref')) return traversePath((it as OASRef)['$ref'], oas);
    return it as OASParameter;
  });
}

function pathParamsParam(pathParameters: string[]): string | undefined {
  if(pathParameters.length === 0) return undefined;
  return `params: {${pathParameters.map(it => `${it}: string`).join('; ')}}`;
}

function typeFrom(oas: OAS, response: OASResponse | OASRef): [string, string[]] {
  const def = Object.prototype.hasOwnProperty.call(response, '$ref') ? traversePath<OASResponse>((response as OASRef)['$ref'], oas) : response as OASResponse;
  const type = Object.keys(def.content ?? ['application/text'])[0];
  const ref = (def.content as any)[type].schema as OASRef;
  if(type === 'application/json') {
    const refValue = ref['$ref'];
    const typeDef = traversePath<JSONSchema>(refValue, oas);
    if(refValue) {
      const typeName = typeDef.title ?? refValue.substring(refValue.lastIndexOf('/') + 1);
      return [typeName, [typeName]]
    }
    return ['unknown', []];
  }
  return ['string', []];
}

function returnType(oas: OAS, method: OASOperation, imports: string[]): string {
  return Object.keys(method.responses).map(statusCode => {
    const response = method.responses[statusCode];
    const [type, newImports] = typeFrom(oas, response)
    imports.push(...newImports);
    return `{ statusCode: ${statusCode}; result: ${type} }`;
  }).join(' | ');
}

function ifCode(code: string, json: boolean): string {
  return `if(result.statusCode === ${code}) {
        return { statusCode: ${code}, headers: result.headers, result: ${json ? `JSON.parse(result.body)` : 'result.body'}  };
      }`
}

function bodyValue(oas: OAS, method: OASOperation): string {
  return Object.keys(method.responses).map(statusCode => {
    const response = method.responses[statusCode];
    const def = Object.prototype.hasOwnProperty.call(response, '$ref') ? traversePath<OASResponse>((response as OASRef)['$ref'], oas) : response as OASResponse;
    const types = Object.keys(def.content ?? {});
    const json = types[0] === 'application/json';
    return ifCode(statusCode, json);
  }).join(' else ');
}

function bodyFrom(oas: OAS, operation: OASOperation): string | undefined {
  if(!operation.requestBody) return undefined;
  const bodyDefinition = Object.prototype.hasOwnProperty.call(operation.requestBody, '$ref') ? traversePath<OASRequestBody>((operation.requestBody as OASRef)['$ref'], oas) : operation.requestBody as OASRequestBody;
  const type = Object.keys(bodyDefinition.content ?? ['application/text'])[0];
  const ref = (bodyDefinition.content as any)[type].schema as OASRef;
  if(type === 'application/json') {
    const refValue = ref['$ref'];
    if(refValue) return refValue.substring(refValue.lastIndexOf('/') + 1);
    return 'unknown';
  }
  return 'string';
}

function sdkMethod(path: string, method: string, pathParameters: string[], oas: OAS, methodDefinition: OASOperation, imports: string[]): string {
  const pathParams = pathParamsParam(pathParameters);
  const bodyParam = bodyFrom(oas, methodDefinition);
  const params = [pathParams, bodyParam && `body: ${bodyParam}`, 'queryParameters: Record<string, string> = {}', 'headers: Record<string, string> = {}'].filter(it => !!it);
  const resourcePath = path.replace(/{/g, '${params.');
  return `    async ${method}${pathName(path)}(${params.join(', ')}): Promise<(${returnType(oas, methodDefinition, imports)}) & {headers: Record<string, string>}>{
      const resource = '${path}';
      const path = \`${resourcePath}\`;
      const result = await this.caller.call(resource, path, ${bodyParam ? 'body': 'undefined'}, ${pathParams ? 'params' : '{}'}, queryParameters, headers);
      ${bodyValue(oas, methodDefinition)}
      throw new Error(\`Unknown status \${result.statusCode} returned from \${path}\`)
    }`;
}

export function generateSdkFrom(oas: OAS): string {
  const name = oas.info.title.replace(/ /g, '') + 'Sdk';
  const paths = pathsFrom(oas);
  const imports = new Array<string>();
  const sdkMethods = paths.flatMap(({path, definition}) => {
    if (definition) {
      return methodOperations(definition).map(({method, definition: operation}) => {
        const parameters = operationParameters(oas, operation);
        const pathParameters = parameters.filter(it => it.in === 'path').map(it => it.name);
        return sdkMethod(path, method, pathParameters, oas, operation, imports);
      });
    } else return [];
  });
  return `import { ${[...new Set([...imports])].join(', ')} } from './model';

class ${name} {
  constructor(
    private readonly caller: {
      call(
        resource: string,
        path: string,
        body: string | undefined,
        pathParameters: Record<string, string>,
        queryParameters: Record<string, string>,
        headers: Record<string, string>
      ): Promise<{ statusCode: number, body: string, headers: Record<string, string> }>
    }
  ){}
${sdkMethods.join('\n\n')}
}`
}