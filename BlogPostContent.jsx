// src/components/BlogPostContent.jsx
import React from 'react';
import { getMDXComponent } from 'mdx-bundler/client';

const BlogPostContent = ({ post }) => {
  // Check if we're in the browser (required for mdx-bundler)
  const [Component, setComponent] = React.useState(() => () => null);

  React.useEffect(() => {
    if (post && post.mdxSource) {
      const MDXComponent = getMDXComponent(post.mdxSource);
      setComponent(() => MDXComponent);
    }
  }, [post]);

  if (!post) return <div>Loading...</div>;

  return (
    <div className="blog-post">
      <h1>{post.meta.title}</h1>
      {post.meta.date && <p className="date">{post.meta.date}</p>}
      {post.meta.author && <p className="author">By {post.meta.author}</p>}
      
      <div className="blog-content">
        <Component />
      </div>
    </div>
  );
};

export default BlogPostContent;