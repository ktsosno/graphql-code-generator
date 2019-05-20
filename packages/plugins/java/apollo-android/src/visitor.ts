import { BaseVisitor, ParsedConfig, getBaseTypeNode, indent, indentMultiline } from '@graphql-codegen/visitor-plugin-common';
import { JavaApolloAndroidPluginConfig } from './plugin';
import { JAVA_SCALARS, JavaDeclarationBlock, wrapTypeWithModifiers, buildPackageNameFromPath } from '@graphql-codegen/java-common';
import { InputObjectTypeDefinitionNode, GraphQLSchema, InputValueDefinitionNode, isScalarType, isInputObjectType, Kind, TypeNode, isEnumType } from 'graphql';
import { Imports } from './imports';

export interface JavaApolloAndroidPluginParsedConfig extends ParsedConfig {
  package: string;
}

const SCALAR_TO_WRITER_METHOD = {
  ID: 'writeString',
  String: 'writeString',
  Int: 'writeInt',
  Boolean: 'writeBoolean',
  Float: 'writeDouble',
};

export class JavaApolloAndroidVisitor extends BaseVisitor<JavaApolloAndroidPluginConfig, JavaApolloAndroidPluginParsedConfig> {
  private _imports = new Set<string>();

  constructor(private _schema: GraphQLSchema, rawConfig: JavaApolloAndroidPluginConfig) {
    super(
      rawConfig,
      {
        package: rawConfig.package || buildPackageNameFromPath(process.cwd()),
      },
      {
        ...JAVA_SCALARS,
        ID: 'String',
      }
    );
  }

  public get imports(): string[] {
    return Array.from(this._imports).map(imp => `import ${imp};`);
  }

  private getActualType(type: TypeNode, wrap = true): string {
    const baseType = getBaseTypeNode(type);
    const schemaType = this._schema.getType(baseType.name.value);
    let typeToUse = schemaType.name;

    if (isScalarType(schemaType)) {
      const scalar = this.config.scalars[schemaType.name] || 'Object';

      if (Imports[scalar]) {
        this._imports.add(Imports[scalar]);
      }

      typeToUse = scalar;
    } else if (isInputObjectType(schemaType)) {
      this._imports.add(`${this.config.package}.${schemaType.name}`);
    }

    const result = wrap ? wrapTypeWithModifiers(typeToUse, type, 'List') : typeToUse;

    if (result.includes('List<')) {
      this._imports.add(Imports.List);
    }

    return result;
  }

  private getFieldWithTypePrefix(field: InputValueDefinitionNode, withInputWrapperWhenNeeded = true): string {
    this._imports.add(Imports.Input);
    const typeToUse = this.getActualType(field.type);
    const isNonNull = field.type.kind === Kind.NON_NULL_TYPE;

    if (isNonNull) {
      this._imports.add(Imports.NonNull);
    }

    if (isNonNull) {
      return `@Nonnull ${typeToUse} ${field.name.value}`;
    } else {
      if (withInputWrapperWhenNeeded) {
        return `Input<${typeToUse}> ${field.name.value}`;
      } else {
        return `${typeToUse} ${field.name.value}`;
      }
    }
  }

  private buildInputPrivateFields(fields: ReadonlyArray<InputValueDefinitionNode>): string[] {
    return fields
      .map<string>(field => {
        const fieldType = this.getFieldWithTypePrefix(field);

        return `private final ${fieldType};`;
      })
      .map(s => indent(s));
  }

  private buildInputCtor(className: string, fields: ReadonlyArray<InputValueDefinitionNode>): string {
    const mappedFields = fields.map<string>(field => this.getFieldWithTypePrefix(field));

    return indentMultiline(`${className}(${mappedFields.join(', ')}) {
${fields.map(field => indent(`this.${field.name.value} = ${field.name.value};`)).join('\n')}
}`);
  }

  private getFieldWriterCall(field: InputValueDefinitionNode, listItemCall = false): string {
    const baseType = getBaseTypeNode(field.type);
    const schemaType = this._schema.getType(baseType.name.value);
    const isNonNull = field.type.kind === Kind.NON_NULL_TYPE;
    let writerMethod = null;

    if (isScalarType(schemaType)) {
      writerMethod = SCALAR_TO_WRITER_METHOD[schemaType.name] || 'writeCustom';
    } else if (isInputObjectType(schemaType)) {
      return listItemCall ? `writeObject($item.marshaller())` : `writeObject("${field.name.value}", ${field.name.value}.value != null ? ${field.name.value}.value.marshaller() : null)`;
    } else if (isEnumType(schemaType)) {
      writerMethod = 'writeString';
    }

    return listItemCall ? `${writerMethod}($item)` : `${writerMethod}("${field.name.value}", ${field.name.value}${isNonNull ? '' : '.value'})`;
  }

  private buildFieldsMarshaller(field: InputValueDefinitionNode): string {
    const isNonNull = field.type.kind === Kind.NON_NULL_TYPE;
    const isArray = field.type.kind === Kind.LIST_TYPE || (field.type.kind === Kind.NON_NULL_TYPE && field.type.type.kind === Kind.LIST_TYPE);
    const call = this.getFieldWriterCall(field, isArray);
    const listItemType = this.getActualType(field.type, false);
    let result = '';

    if (isArray) {
      result = `writer.writeList("${field.name.value}", ${field.name.value}.value != null ? new InputFieldWriter.ListWriter() {
  @Override
  public void write(InputFieldWriter.ListItemWriter listItemWriter) throws IOException {
    for (${listItemType} $item : ${field.name.value}.value) {
      listItemWriter.${call};
    }
  }
} : null);`;
    } else {
      result = indent(`writer.${call};`);
    }

    if (isNonNull) {
      return result;
    } else {
      return indentMultiline(`if(${field.name.value}.defined) {
${indentMultiline(result)}
}`);
    }
  }

  private buildMarshallerOverride(fields: ReadonlyArray<InputValueDefinitionNode>): string {
    this._imports.add(Imports.Override);
    this._imports.add(Imports.IOException);
    this._imports.add(Imports.InputFieldWriter);
    this._imports.add(Imports.InputFieldMarshaller);
    const allMarshallers = fields.map(field => indentMultiline(this.buildFieldsMarshaller(field), 2));

    return indentMultiline(`@Override
public InputFieldMarshaller marshaller() {
  return new InputFieldMarshaller() {
    @Override
    public void marshal(InputFieldWriter writer) throws IOException {
${allMarshallers.join('\n')}
    }
  };
}`);
  }

  private buildBuilderNestedClass(className: string, fields: ReadonlyArray<InputValueDefinitionNode>): string {
    const builderClassName = 'Builder';
    const privateFields = fields
      .map<string>(field => {
        const fieldType = this.getFieldWithTypePrefix(field);
        const isNonNull = field.type.kind === Kind.NON_NULL_TYPE;

        return `private ${fieldType}${isNonNull ? '' : ' = Input.absent()'};`;
      })
      .map(s => indent(s));

    const setters = fields
      .map<string>(field => {
        const fieldType = this.getFieldWithTypePrefix(field, false);
        const isNonNull = field.type.kind === Kind.NON_NULL_TYPE;

        return `\npublic ${builderClassName} ${field.name.value}(${isNonNull ? '' : '@Nullable '}${fieldType}) {
  this.${field.name.value} = ${isNonNull ? field.name.value : `Input.fromNullable(${field.name.value})`};
  return this;
}`;
      })
      .map(s => indentMultiline(s));

    const nonNullFields = fields
      .filter(f => f.type.kind === Kind.NON_NULL_TYPE)
      .map<string>(nnField => {
        this._imports.add(Imports.Utils);

        return indent(`Utils.checkNotNull(${nnField.name.value}, "${nnField.name.value} == null");`, 1);
      });

    const ctor = '\n' + indent(`${builderClassName}() {}`);
    const buildFn = indentMultiline(`public ${className} build() {
${nonNullFields.join('\n')}
  return new ${className}(${fields.map(f => f.name.value).join(', ')});
}`);
    const body = [...privateFields, ctor, ...setters, '', buildFn].join('\n');

    return indentMultiline(
      new JavaDeclarationBlock()
        .withName(builderClassName)
        .access('public')
        .final()
        .static()
        .withBlock(body)
        .asKind('class').string
    );
  }

  private buildInputGetters(fields: ReadonlyArray<InputValueDefinitionNode>): string[] {
    return fields
      .map<string>(field => {
        const fieldType = this.getFieldWithTypePrefix(field);
        const isNullable = field.type.kind !== Kind.NON_NULL_TYPE;

        if (isNullable) {
          this._imports.add(Imports.Nullable);
        }

        return `public ${isNullable ? '@Nullable ' : ''}${fieldType}() { return this.${field.name.value}; }`;
      })
      .map(s => indent(s));
  }

  InputObjectTypeDefinition(node: InputObjectTypeDefinitionNode): string {
    const className = node.name.value;
    this._imports.add(Imports.InputType);
    this._imports.add(Imports.Generated);

    const privateFields = this.buildInputPrivateFields(node.fields);
    const ctor = this.buildInputCtor(className, node.fields);
    const getters = this.buildInputGetters(node.fields);
    const builderGetter = indent(`public static Builder builder() { return new Builder(); }`);
    const marshallerOverride = this.buildMarshallerOverride(node.fields);
    const builderClass = this.buildBuilderNestedClass(className, node.fields);

    const classBlock = [...privateFields, '', ctor, '', ...getters, '', builderGetter, '', marshallerOverride, '', builderClass].join('\n');

    return new JavaDeclarationBlock()
      .annotate([`Generated("Apollo GraphQL")`])
      .access('public')
      .final()
      .asKind('class')
      .withName(className)
      .withBlock(classBlock)
      .implements(['InputType']).string;
  }
}
