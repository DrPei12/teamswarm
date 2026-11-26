export function allowedResponsesTools(body) {
  function leaf(tool) {
    return tool && (tool.type === 'function' || tool.type === 'custom') &&
      typeof tool.name === 'string' && tool.name.length > 0;
  }
  function tools(list) {
    return Array.isArray(list) && list.every(tool => leaf(tool) || (
      tool?.type === 'namespace' && typeof tool.name === 'string' && tool.name.length > 0 &&
      Array.isArray(tool.tools) && tool.tools.length > 0 && tool.tools.every(leaf)
    ));
  }
  return (body.tools === undefined || tools(body.tools)) &&
    (!Array.isArray(body.input) || body.input.every(item => item?.type !== 'additional_tools' || tools(item.tools)));
}
