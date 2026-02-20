export default function Home() {
  return <div></div>;
}

export async function getStaticProps() {
  return {
    props: {
      pathname: '/',
    },
  };
}
